const {
  DEFAULT_MODEL_KEY,
  KEEP_RECENT_MESSAGES,
  MAX_HISTORY_CHARS,
  MAX_TOOL_STEPS,
  MODELS,
  REQUEST_TIMEOUT_MS,
} = require('../config');
const { chat, chatSilent } = require('../model/scraperClient');
const {
  buildConversationMessages,
  buildSystemPrompt,
  buildToolErrorMessage,
  buildToolResultMessage,
  parseAgentResponse,
  sanitizeArgsForModel,
} = require('./prompts');
const {
  executeToolCall,
  getToolPromptText,
  parseDirectAction,
} = require('../tools');
const {
  appendTranscriptEntry,
} = require('../utils/transcriptStorage');
const {
  estimateHistoryChars,
  saveState,
} = require('../utils/sessionStorage');
const { normalizeText, shortText } = require('../utils/text');

async function requestModel(messages, state, ui, options = {}) {
  const {
    label = 'Pensando',
    streamOutput = false,
  } = options;
  const stopThinking = ui.startThinkingIndicator(state, label);
  let answerStarted = false;
  let thinkingStarted = false;

  try {
    const result = await Promise.race([
      chat({
        messages,
        modelKey: state?.activeModel || DEFAULT_MODEL_KEY,
        onChunk: (delta, phase) => {
          if (phase === 'thinking') {
            if (!thinkingStarted) {
              stopThinking();
              ui.beginThinkingStream(state);
              thinkingStarted = true;
            }
            ui.writeThinkingDelta(state, delta);
            return;
          }

          if (thinkingStarted) {
            ui.endThinkingStream(state);
            thinkingStarted = false;
          }

          if (streamOutput && !answerStarted) {
            stopThinking();
            ui.beginAssistantStream(state);
            answerStarted = true;
          }

          if (streamOutput) {
            ui.writeAssistantDelta(state, delta);
          }
        },
      }),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('El modelo tardo demasiado en responder'));
        }, REQUEST_TIMEOUT_MS);
      }),
    ]);
    ui.pushAction(state, 'ok', 'Respuesta del modelo recibida');
    return result.answer ?? '';
  } finally {
    stopThinking();
    if (thinkingStarted) ui.endThinkingStream(state);
    if (streamOutput && answerStarted) {
      ui.endAssistantStream(state);
    }
  }
}

async function summarizeMessages(state, ui, messages) {
  const transcript = messages
    .map(message => `${message.role.toUpperCase()}:\n${message.content}`)
    .join('\n\n');

  const prompt = [
    {
      role: 'system',
      content: [
        'Resume la conversacion para memoria persistente.',
        'Escribe en espanol.',
        'Incluye objetivos, decisiones, archivos, comandos, restricciones y pendientes importantes.',
        'Maximo 12 lineas.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        state.memorySummary ? `Memoria previa:\n${state.memorySummary}\n` : '',
        'Conversacion a compactar:',
        transcript,
      ].join('\n'),
    },
  ];

  return normalizeText(await requestModel(prompt, state, ui, {
    label: 'Compactando memoria',
  }));
}

async function compactHistoryIfNeeded(state, ui) {
  if (estimateHistoryChars(state.history) <= MAX_HISTORY_CHARS) {
    return;
  }

  if (state.history.length <= KEEP_RECENT_MESSAGES) {
    return;
  }

  const splitIndex = Math.max(2, state.history.length - KEEP_RECENT_MESSAGES);
  const oldMessages = state.history.slice(0, splitIndex);
  const recentMessages = state.history.slice(splitIndex);
  const summary = await summarizeMessages(state, ui, oldMessages);

  state.memorySummary = summary;
  state.history = recentMessages;
  ui.logEvent(state, 'info', 'Memoria compactada', shortText(summary, 100));
  await appendTranscriptEntry(state.sessionId, {
    type: 'system',
    content: `Memoria compactada:\n${summary}`,
  });
}

async function persistSessionState(state, ui) {
  await compactHistoryIfNeeded(state, ui);
  await saveState(state);
}

async function appendVisibleTurn(state, role, content) {
  state.history.push({ role, content });
  await appendTranscriptEntry(state.sessionId, {
    type: role,
    content,
  });
}

async function answerFromToolResult(input, call, result, state, ui) {
  const messages = [
    {
      role: 'system',
      content: [
        'Eres Adonix.',
        'Responde en espanol, directo y solo con la respuesta final.',
        'Usa solo los datos del resultado de herramienta dado.',
        `Directorio actual: ${state.cwd}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Solicitud original del usuario:',
        input,
        '',
        `Resultado de la herramienta ${call.tool}:`,
        result,
      ].join('\n'),
    },
  ];

  const output = await requestModel(messages, state, ui, {
    label: 'Resumiendo resultado',
    streamOutput: true,
  });
  return normalizeText(output);
}

async function runAgentTurn(input, state, ui) {
  state.turnCount += 1;
  if (state.turnCount === 1 && state.title === 'Nueva sesion') {
    state.title = shortText(input, 60) || state.title;
  }
  ui.logEvent(state, 'info', `Turno ${state.turnCount}`);

  const directAction = parseDirectAction(input);
  if (directAction) {
    await appendTranscriptEntry(state.sessionId, {
      type: 'user',
      content: input,
    });
    const result = await executeToolCall(directAction, state, ui);
    await appendTranscriptEntry(state.sessionId, {
      type: 'tool',
      tool: directAction.tool,
      args: directAction.args,
      result,
    });
    const finalAnswer = await answerFromToolResult(input, directAction, result, state, ui);
    state.history.push({ role: 'user', content: input });
    state.history.push({ role: 'assistant', content: finalAnswer });
    await appendTranscriptEntry(state.sessionId, {
      type: 'assistant',
      content: finalAnswer,
    });
    ui.logEvent(state, 'ok', 'Respuesta lista');
    await persistSessionState(state, ui);
    return {
      content: finalAnswer,
      rendered: true,
    };
  }

  const turnMessages = [{ role: 'user', content: input }];
  await appendTranscriptEntry(state.sessionId, {
    type: 'user',
    content: input,
  });

  let lastFingerprint = '';
  let repeatCount = 0;

  for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
    const injected = typeof state.getQueuedMessages === 'function'
      ? state.getQueuedMessages()
      : [];
    for (const msg of injected) {
      const note = `MENSAJE_ADICIONAL_DEL_USUARIO:\n${msg}`;
      turnMessages.push({ role: 'user', content: note });
      ui.logEvent(state, 'info', 'Mensaje recibido en vivo', shortText(msg, 60));
    }

    const messages = buildConversationMessages(
      state,
      turnMessages,
      buildSystemPrompt(state.cwd, state),
    );

    const primaryPromise = requestModel(messages, state, ui, {
      label: step === 0 ? 'Pensando' : `Paso ${step + 1}`,
    });

    let secondaryPromise = null;
    if (state.concuerdo) {
      const altKey = (state.activeModel || DEFAULT_MODEL_KEY) === 'qwen' ? 'deepseek' : 'qwen';
      secondaryPromise = chatSilent({ messages, modelKey: altKey }).catch(() => null);
    }

    const raw = await primaryPromise;
    let parsed = parseAgentResponse(raw);

    if (secondaryPromise) {
      const altResult = await secondaryPromise;
      if (altResult?.answer) {
        const altKey = (state.activeModel || DEFAULT_MODEL_KEY) === 'qwen' ? 'deepseek' : 'qwen';
        const altParsed = parseAgentResponse(altResult.answer);

        if (parsed.type === 'final' && altParsed.type === 'tool') {
          ui.logEvent(state, 'info', `${MODELS[altKey].label} sugiere ${altParsed.tool}`);
          parsed = altParsed;
        } else if (parsed.type === 'final' && altParsed.type === 'final' && altParsed.content?.trim()) {
          ui.logEvent(state, 'info', `Perspectiva de ${MODELS[altKey].label} integrada`);
          parsed = { type: 'final', content: parsed.content + '\n\n---\n' + altParsed.content };
        } else if (parsed.type === 'tool' && altParsed.type === 'tool') {
          ui.logEvent(state, 'info', `${MODELS[altKey].label} concuerda: ${altParsed.tool}`);
        }
      }
    }

    if (parsed.type === 'final') {
      const content = parsed.content.trim();
      turnMessages.push({ role: 'assistant', content: content || raw.trim() });
      state.history.push(...turnMessages);
      await appendTranscriptEntry(state.sessionId, {
        type: 'assistant',
        content,
      });
      ui.logEvent(state, 'ok', 'Respuesta lista');
      await persistSessionState(state, ui);
      return {
        content,
        rendered: false,
      };
    }

    const fingerprint = `${parsed.tool}:${parsed.args?.path || ''}:${(parsed.args?.content || parsed.args?.search || '').length}`;
    if (fingerprint === lastFingerprint) {
      repeatCount += 1;
      if (repeatCount >= 2) {
        ui.logEvent(state, 'warn', 'Loop detectado', `${parsed.tool} repetido ${repeatCount + 1}x`);
        turnMessages.push({
          role: 'user',
          content: 'ATENCION: Estas repitiendo la misma operacion. La operacion anterior ya fue exitosa. Responde con type=final confirmando lo que hiciste.',
        });
        continue;
      }
    } else {
      lastFingerprint = fingerprint;
      repeatCount = 0;
    }

    turnMessages.push({
      role: 'assistant',
      content: JSON.stringify(
        {
          type: 'tool',
          tool: parsed.tool,
          args: sanitizeArgsForModel(parsed),
        },
        null,
        2,
      ),
    });

    try {
      const result = await executeToolCall(parsed, state, ui);
      await appendTranscriptEntry(state.sessionId, {
        type: 'tool',
        tool: parsed.tool,
        args: parsed.args,
        result,
      });
      turnMessages.push({
        role: 'user',
        content: `TOOL_RESULT\n${buildToolResultMessage(parsed, result)}`,
      });
    } catch (err) {
      ui.logEvent(state, 'error', 'Fallo de herramienta', err.message);
      await appendTranscriptEntry(state.sessionId, {
        type: 'tool_error',
        tool: parsed.tool,
        args: parsed.args,
        error: err.message,
      });
      turnMessages.push({
        role: 'user',
        content: buildToolErrorMessage(parsed, err.message),
      });
    }
  }

  const fallback =
    'No pude completar la tarea dentro del limite de herramientas. Intenta dividirla.';

  turnMessages.push({
    role: 'assistant',
    content: fallback,
  });
  state.history.push(...turnMessages);
  await appendTranscriptEntry(state.sessionId, {
    type: 'assistant',
    content: fallback,
  });
  ui.logEvent(state, 'warn', 'Limite alcanzado');
  await persistSessionState(state, ui);
  return {
    content: fallback,
    rendered: false,
  };
}

module.exports = {
  runAgentTurn,
};
