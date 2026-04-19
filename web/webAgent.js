const { chat, chatSilent } = require('../src/model/scraperClient');
const { parseAgentResponse } = require('../src/core/prompts');
const { buildSkillsPrompt } = require('../src/core/skills');
const { DEFAULT_MODEL_KEY, MODELS } = require('../src/config');
const githubApi = require('./githubApi');
const store = require('./store');

const MAX_STEPS = 15;
const CONCUERDO_TIMEOUT = 30000;
const WEB_SKILLS = ['core', 'web-agent', 'code-style', 'reasoning', 'methodology'];

function buildSystemPrompt(repoOwner, repoName, fileTree, state = {}) {
  const skills = buildSkillsPrompt({ include: WEB_SKILLS });

  const treeLines = fileTree
    .filter(f => !f.path.includes('node_modules/') && !f.path.includes('.git/'))
    .slice(0, 200)
    .map(f => `  ${f.path} (${f.size}b)`)
    .join('\n');

  const parts = [
    skills,
    '',
    '# Entorno',
    `Repositorio: ${repoOwner}/${repoName}`,
    `Fecha: ${new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' })}`,
    '',
    'Archivos del repositorio:',
    treeLines,
  ];

  if (state.concuerdo) {
    const activeKey = state.activeModel || DEFAULT_MODEL_KEY;
    const otherKeys = Object.keys(MODELS).filter(k => k !== activeKey);
    const otherLabels = otherKeys.map(k => MODELS[k]?.label || k).join(', ');
    parts.push(
      '',
      '# Modo Concuerdo (ACTIVO)',
      `Trabajas en colaboracion con ${otherKeys.length} modelos: ${otherLabels}.`,
      'Si el usuario pregunta, confirma que SI trabajas junto a otros modelos.',
    );
  }

  return parts.join('\n');
}

async function runWebAgent({ chatData, user, onEvent, isAborted }) {
  const { repoOwner, repoName, messages: history } = chatData;
  const modelKey = chatData.activeModel || DEFAULT_MODEL_KEY;
  const concuerdo = chatData.concuerdo || false;

  const modelLabel = MODELS[modelKey]?.label || modelKey;
  onEvent({ type: 'model_info', model: modelKey, label: modelLabel, concuerdo });

  let fileTree = [];
  try {
    fileTree = await githubApi.getTree(user.githubToken, repoOwner, repoName);
    onEvent({ type: 'status', content: `${fileTree.length} archivos en el repo` });
  } catch (err) {
    onEvent({ type: 'error', content: `Error cargando repo: ${err.message}` });
    return;
  }

  const systemPrompt = buildSystemPrompt(repoOwner, repoName, fileTree, {
    concuerdo,
    activeModel: modelKey,
  });
  const modelMessages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    if (isAborted?.()) return;

    let answer = '';
    let thinkingContent = '';

    onEvent({
      type: 'thinking_start',
      content: step === 0 ? 'Pensando...' : `Paso ${step + 1}...`,
    });

    try {
      const result = await chat({
        messages: modelMessages,
        modelKey,
        onChunk: (delta, phase) => {
          if (isAborted?.()) return;
          if (phase === 'thinking') {
            thinkingContent += delta;
            onEvent({ type: 'thinking_delta', content: delta });
          } else {
            answer += delta;
            onEvent({ type: 'delta', content: delta });
          }
        },
      });
      answer = result.answer || answer;
    } catch (err) {
      onEvent({ type: 'error', content: `Error del modelo: ${err.message}` });
      return;
    }

    if (thinkingContent) {
      onEvent({ type: 'thinking_end', content: thinkingContent });
    }

    const parsed = parseAgentResponse(answer);

    if (parsed.type === 'final' && concuerdo) {
      const otherKeys = Object.keys(MODELS).filter(k => k !== modelKey);

      if (otherKeys.length > 0) {
        onEvent({ type: 'concuerdo_start', models: otherKeys.map(k => MODELS[k].label) });

        const withTimeout = (promise) => Promise.race([
          promise,
          new Promise(r => setTimeout(() => r(null), CONCUERDO_TIMEOUT)),
        ]);

        const secondaryPromises = otherKeys.map(k =>
          withTimeout(chatSilent({ messages: modelMessages, modelKey: k }).catch(() => null))
        );

        const settled = await Promise.allSettled(secondaryPromises);
        const extras = [];

        for (let i = 0; i < settled.length; i++) {
          if (isAborted?.()) return;
          const val = settled[i].status === 'fulfilled' ? settled[i].value : null;
          const label = MODELS[otherKeys[i]]?.label || otherKeys[i];

          if (val?.answer?.trim()) {
            const altParsed = parseAgentResponse(val.answer);
            if (altParsed.type === 'final' && altParsed.content?.trim()) {
              extras.push({ content: altParsed.content, label });
              onEvent({ type: 'concuerdo_model', label, status: 'ok' });
            } else {
              onEvent({ type: 'concuerdo_model', label, status: 'skip' });
            }
          } else {
            onEvent({ type: 'concuerdo_model', label, status: 'timeout' });
          }
        }

        if (extras.length > 0) {
          onEvent({ type: 'concuerdo_synthesis', content: 'Sintetizando respuestas...' });

          const synthMessages = [
            {
              role: 'system',
              content: [
                'Eres Adonix. Varios modelos analizaron la misma pregunta.',
                'Crea UNA SOLA respuesta final unificada.',
                'Integra perspectivas unicas. Se directo. Responde en español.',
                'NO menciones que sintetizas ni que hay multiples modelos.',
              ].join('\n'),
            },
            {
              role: 'user',
              content: [
                `Respuesta de ${modelLabel}:\n${parsed.content}`,
                '',
                ...extras.map(e => `Respuesta de ${e.label}:\n${e.content}`),
                '',
                'Crea la respuesta final unificada:',
              ].join('\n'),
            },
          ];

          try {
            let synthAnswer = '';
            onEvent({ type: 'synth_start' });
            await chat({
              messages: synthMessages,
              modelKey,
              onChunk: (delta, phase) => {
                if (isAborted?.()) return;
                if (phase !== 'thinking') {
                  synthAnswer += delta;
                  onEvent({ type: 'synth_delta', content: delta });
                }
              },
            });
            if (synthAnswer.trim()) {
              chatData.messages.push({
                role: 'assistant',
                content: synthAnswer.trim(),
                ts: Date.now(),
              });
              store.saveChat(chatData);
              onEvent({ type: 'done', content: synthAnswer.trim() });
              return;
            }
          } catch {
            // Fallo de sintesis — usar respuesta primaria
          }
        }
      }
    }

    if (parsed.type === 'final') {
      chatData.messages.push({
        role: 'assistant',
        content: parsed.content,
        ts: Date.now(),
      });
      store.saveChat(chatData);
      onEvent({ type: 'done', content: parsed.content });
      return;
    }

    if (parsed.type === 'tool') {
      const { tool, args } = parsed;
      onEvent({ type: 'tool', name: tool, path: args.path || '' });

      let toolResult;
      try {
        if (tool === 'read_file') {
          const file = await githubApi.readFile(
            user.githubToken, repoOwner, repoName, args.path,
          );
          toolResult = file.content;
          onEvent({ type: 'tool_done', content: `📄 ${args.path} leido` });
        } else if (tool === 'write_file') {
          if (!args.content || args.content.length < 2) {
            toolResult = 'Error: contenido vacio o demasiado corto. Lee el archivo primero con read_file.';
            onEvent({ type: 'tool_error', content: toolResult });
          } else {
            await githubApi.writeFile(
              user.githubToken, repoOwner, repoName,
              args.path, args.content, user.githubEmail,
            );
            toolResult = `Archivo ${args.path} actualizado y commiteado en GitHub.`;
            const fname = args.path.split('/').pop();
            onEvent({ type: 'tool_done', content: `✅ Commit: Update ${fname}` });
          }
        } else {
          toolResult = `Herramienta "${tool}" no disponible en modo web. Usa read_file o write_file.`;
          onEvent({ type: 'tool_done', content: toolResult });
        }
      } catch (err) {
        toolResult = `Error: ${err.message}`;
        onEvent({ type: 'tool_error', content: toolResult });
      }

      modelMessages.push({ role: 'assistant', content: answer });
      modelMessages.push({
        role: 'user',
        content: `TOOL_RESULT [${tool}]:\n${toolResult}`,
      });
    }
  }

  onEvent({ type: 'error', content: 'Se alcanzo el limite de pasos.' });
}

module.exports = { runWebAgent };
