const { chat, chatSilent } = require('../src/model/scraperClient');
const { parseAgentResponse } = require('../src/core/prompts');
const { buildSkillsPrompt } = require('../src/core/skills');
const { DEFAULT_MODEL_KEY, MODELS } = require('../src/config');
const githubApi = require('./githubApi');
const store = require('./store');

const MAX_STEPS = 15;
const CONCUERDO_TIMEOUT = 30000;
const BUFFER_CHECK = 12;
const WEB_SKILLS = ['core', 'web-agent', 'code-style', 'reasoning', 'methodology'];
const TOOL_HINT_RE = /"tool"\s*:\s*"(list_dir|read_file|search_text|glob_files|file_info|write_file|append_file|replace_in_file|run_command|make_dir|fetch_url|web_search|web_read)"/i;
const XML_TOOL_RE = /<invoke\s+name=|<\w+:tool_call>/i;
const INTERNAL_PLAN_START_RE = /^(el usuario|necesito|primero|voy a|debo|tengo que|para hacer esto|mi siguiente paso|entendido|dejame|déjame)\b/i;
const INTERNAL_PLAN_ACTION_RE = /(read_file|write_file|leer el archivo|leer primero|editar el archivo|modificar el archivo|hacer el cambio|quitar el comentario|analizar|inspeccionar|usar la herramienta|ver el archivo|continuar|resolver)/i;
const DEFERAL_RE = /(¿(quieres|necesitas|prefieres).*(vea|revise|aplique|cambie|lea)|si (quieres|necesitas) puedo|puedo ver el codigo exacto|puedo revisar el archivo exacto|voy a leer (ambos|estos|esos) archivos)/i;
const TEXT_FILE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt',
  '.html', '.css', '.scss', '.sass', '.less', '.yml', '.yaml', '.xml',
  '.sh', '.bash', '.zsh', '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.php', '.rb', '.sql', '.env', '.ini', '.toml',
]);

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
    '# Reglas de autonomia',
    '- Si el usuario pide un cambio, debes hacerlo de punta a punta.',
    '- Si el usuario dice "continua", debes seguir trabajando.',
    '- Si no sabes el archivo exacto, usa search_text, glob_files o list_dir.',
    '- No preguntes "quieres que..." ni "necesitas que..." si puedes investigarlo tu.',
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
      `Trabajas junto a ${otherKeys.length} modelos: ${otherLabels}.`,
      'Si el usuario pregunta, confirma que trabajas en equipo con otros modelos.',
    );
  }

  return parts.join('\n');
}

function looksLikeToolPayload(text) {
  const sample = text.trimStart().slice(0, 240);
  if (!sample) return false;

  return /^\{/.test(sample)
    || XML_TOOL_RE.test(sample)
    || /^```(?:json)?/i.test(sample)
    || /"type"\s*:\s*"tool"/i.test(sample)
    || TOOL_HINT_RE.test(sample);
}

function looksLikeInternalPlan(text) {
  const sample = String(text || '').trimStart().slice(0, 320);
  if (!sample || looksLikeToolPayload(sample)) return false;

  return INTERNAL_PLAN_START_RE.test(sample) && INTERNAL_PLAN_ACTION_RE.test(sample);
}

function looksLikeDeferral(text) {
  const sample = String(text || '').trimStart().slice(0, 320);
  if (!sample || looksLikeToolPayload(sample)) return false;
  return DEFERAL_RE.test(sample);
}

function normalizeRepoPath(value = '') {
  return String(value).replace(/^\.?\//, '').replace(/\/+$/, '').trim();
}

function escapeRegex(text) {
  return text.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(pattern = '') {
  const normalized = normalizeRepoPath(pattern);
  if (!normalized) return /^.*$/;

  let source = '^';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const next = normalized[i + 1];

    if (ch === '*' && next === '*') {
      source += '.*';
      i++;
      continue;
    }

    if (ch === '*') {
      source += '[^/]*';
      continue;
    }

    if (ch === '?') {
      source += '.';
      continue;
    }

    source += escapeRegex(ch);
  }

  source += '$';
  return new RegExp(source, 'i');
}

function matchesPathPrefix(filePath, prefix = '') {
  const cleanPrefix = normalizeRepoPath(prefix);
  if (!cleanPrefix) return true;
  return filePath === cleanPrefix || filePath.startsWith(`${cleanPrefix}/`);
}

function isLikelyTextFile(file) {
  if (!file?.path || file.size > 200_000) return false;
  const dot = file.path.lastIndexOf('.');
  if (dot === -1) return true;
  return TEXT_FILE_EXTENSIONS.has(file.path.slice(dot).toLowerCase());
}

function normalizeReplyFingerprint(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}./_-]+/gu, ' ')
    .trim()
    .slice(0, 240);
}

function getLatestUserPrompt(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item?.role !== 'user') continue;
    const content = String(item.content || '').trim();
    if (!content || /^TOOL_RESULT\b/.test(content)) continue;
    return content;
  }
  return '';
}

function extractMentionedPaths(text, fileTree) {
  const sample = String(text || '');
  if (!sample.trim()) return [];

  const found = new Set();
  const directMatches = sample.match(/(?:[\w.-]+\/)+[\w.-]+\.[\w-]+|[\w.-]+\.[\w-]+/g) || [];

  for (const raw of directMatches) {
    const token = normalizeRepoPath(raw);
    if (!token) continue;

    const exact = fileTree.find(file => file.path === token);
    if (exact) {
      found.add(exact.path);
      continue;
    }

    const bySuffix = fileTree.filter(file => file.path.endsWith(`/${token}`) || file.path === token);
    for (const file of bySuffix.slice(0, 3)) found.add(file.path);
  }

  if (found.size) return [...found].slice(0, 3);

  for (const file of fileTree) {
    const base = file.path.split('/').pop();
    if (!base) continue;
    const safe = escapeRegex(base);
    if (new RegExp(`(^|\\W)${safe}(\\W|$)`, 'i').test(sample)) {
      found.add(file.path);
      if (found.size >= 3) break;
    }
  }

  return [...found];
}

function extractSearchPattern(text, fallbackText = '') {
  const primary = String(text || '');
  const secondary = String(fallbackText || '');

  const slash = primary.match(/\/([a-z0-9_-]+)/i) || secondary.match(/\/([a-z0-9_-]+)/i);
  if (slash?.[1]) return slash[1];

  const quoted = primary.match(/["'`](.+?)["'`]/) || secondary.match(/["'`](.+?)["'`]/);
  if (quoted?.[1]?.trim()) return quoted[1].trim();

  const candidates = `${primary} ${secondary}`
    .match(/[A-Za-z_][A-Za-z0-9._/-]{2,}/g) || [];

  const stop = new Set([
    'quiero', 'cuando', 'muestre', 'muestra', 'usuario', 'nombre', 'nombres',
    'database', 'desde', 'base', 'datos', 'resolver', 'archivo', 'archivos',
    'comentario', 'continua', 'corrige', 'arregla', 'problema', 'necesito',
    'puede', 'puedes', 'debe', 'debes', 'hacer', 'haciendo', 'mencion',
  ]);

  const token = candidates.find(word => !stop.has(word.toLowerCase()));
  return token || '';
}

function getFilesByGlob(fileTree, { pattern, path }) {
  const regex = globToRegExp(pattern || '**/*');
  return fileTree
    .filter(file => matchesPathPrefix(file.path, path))
    .filter(file => regex.test(file.path))
    .map(file => file.path);
}

async function searchTextInRepo(ctx, { pattern, path, glob }) {
  const query = String(pattern || '').trim();
  if (!query) return [];

  const regex = glob ? globToRegExp(glob) : null;
  const candidates = ctx.fileTree
    .filter(file => matchesPathPrefix(file.path, path))
    .filter(file => !regex || regex.test(file.path))
    .filter(isLikelyTextFile)
    .slice(0, 60);

  const results = [];
  const needle = query.toLowerCase();

  for (const file of candidates) {
    try {
      const current = await githubApi.readFile(ctx.token, ctx.owner, ctx.repo, file.path);
      const lines = current.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        results.push(`${file.path}:${i + 1}: ${lines[i].trim()}`);
        if (results.length >= 50) return results;
      }
    } catch {}
  }

  return results;
}

async function attemptAutomaticRecovery(answer, history, ctx, state) {
  const fingerprint = normalizeReplyFingerprint(answer);
  const latestUserPrompt = getLatestUserPrompt(history);
  const mentionedPaths = extractMentionedPaths(answer, ctx.fileTree);

  for (const path of mentionedPaths) {
    const key = `read:${path}`;
    if (state.autoActions.has(key)) continue;
    state.autoActions.add(key);
    const toolResult = await executeTool('read_file', { path }, ctx);
    return {
      assistant: answer,
      followUps: [{ tool: 'read_file', content: toolResult }],
    };
  }

  const pattern = extractSearchPattern(answer, latestUserPrompt);
  if (pattern) {
    const key = `search:${pattern.toLowerCase()}`;
    if (!state.autoActions.has(key)) {
      state.autoActions.add(key);
      const toolResult = await executeTool('search_text', {
        pattern,
        glob: '**/*.js',
      }, ctx);
      return {
        assistant: answer,
        followUps: [{ tool: 'search_text', content: toolResult }],
      };
    }
  }

  if (fingerprint && state.lastFingerprint === fingerprint) {
    state.repeatCount += 1;
  } else {
    state.lastFingerprint = fingerprint;
    state.repeatCount = 1;
  }

  return null;
}

async function executeTool(tool, args, ctx) {
  ctx.onEvent({ type: 'tool', name: tool, path: args.path || args.query || '' });

  try {
    switch (tool) {
      case 'read_file': {
        const file = await githubApi.readFile(ctx.token, ctx.owner, ctx.repo, args.path);
        ctx.onEvent({ type: 'tool_done', content: `${args.path} leido` });
        return file.content;
      }
      case 'write_file': {
        if (!args.content || args.content.length < 2) {
          const msg = 'Error: contenido vacio. Lee el archivo primero con read_file.';
          ctx.onEvent({ type: 'tool_error', content: msg });
          return msg;
        }
        const writeResult = await githubApi.writeFile(
          ctx.token,
          ctx.owner,
          ctx.repo,
          args.path,
          args.content,
          {
          name: ctx.authorName,
          email: ctx.email,
          },
        );
        const shortSha = writeResult.commitSha.slice(0, 7);
        const commitLabel = shortSha
          ? `${writeResult.commitMessage} · ${shortSha}`
          : writeResult.commitMessage;
        ctx.onEvent({
          type: 'tool_done',
          content: `Commit real: ${commitLabel}`,
          meta: {
            path: writeResult.path,
            addedLines: writeResult.addedLines,
            removedLines: writeResult.removedLines,
            commitSha: writeResult.commitSha,
            commitUrl: writeResult.commitUrl,
          },
        });
        return [
          `Archivo ${writeResult.path} actualizado y commiteado.`,
          `Diff: +${writeResult.addedLines} -${writeResult.removedLines}`,
          `Commit real: ${writeResult.commitMessage}`,
          writeResult.commitSha ? `SHA: ${writeResult.commitSha}` : '',
          writeResult.commitUrl ? `URL: ${writeResult.commitUrl}` : '',
          `Autor: ${writeResult.authorName} <${writeResult.authorEmail}>`,
        ].filter(Boolean).join('\n');
      }
      case 'list_dir': {
        const dir = (args.path || '').replace(/\/$/, '');
        const items = ctx.fileTree
          .filter(f => dir ? f.path.startsWith(dir + '/') : true)
          .slice(0, 100)
          .map(f => f.path);
        ctx.onEvent({ type: 'tool_done', content: `${items.length} archivos` });
        return items.join('\n') || 'Directorio vacio';
      }
      case 'search_text': {
        const matches = await searchTextInRepo(ctx, args);
        ctx.onEvent({ type: 'tool_done', content: `${matches.length} coincidencias` });
        return matches.join('\n') || 'Sin resultados';
      }
      case 'glob_files': {
        const matches = getFilesByGlob(ctx.fileTree, {
          pattern: args.pattern || args.glob || '**/*',
          path: args.path || '',
        }).slice(0, 100);
        ctx.onEvent({ type: 'tool_done', content: `${matches.length} resultados` });
        return matches.join('\n') || 'Sin resultados';
      }
      case 'file_info': {
        const info = ctx.fileTree.find(f => f.path === args.path);
        if (!info) {
          ctx.onEvent({ type: 'tool_error', content: 'Archivo no encontrado' });
          return 'Archivo no encontrado en el repo.';
        }
        ctx.onEvent({ type: 'tool_done', content: args.path });
        return `path: ${info.path}\nsize: ${info.size} bytes`;
      }
      default: {
        const msg = `Herramienta "${tool}" no disponible en modo web.`;
        ctx.onEvent({ type: 'tool_done', content: msg });
        return msg;
      }
    }
  } catch (err) {
    const msg = `Error: ${err.message}`;
    ctx.onEvent({ type: 'tool_error', content: msg });
    return msg;
  }
}

async function runConcuerdo(primaryContent, primaryKey, modelMessages, onEvent, isAborted) {
  const otherKeys = Object.keys(MODELS).filter(k => k !== primaryKey);
  if (!otherKeys.length) return null;

  onEvent({ type: 'concuerdo_start', models: otherKeys.map(k => MODELS[k].label) });

  const withTimeout = (p) => Promise.race([
    p,
    new Promise(r => setTimeout(() => r(null), CONCUERDO_TIMEOUT)),
  ]);

  const results = await Promise.allSettled(
    otherKeys.map(k => withTimeout(chatSilent({ messages: modelMessages, modelKey: k }).catch(() => null)))
  );

  const extras = [];
  for (let i = 0; i < results.length; i++) {
    if (isAborted?.()) return null;
    const val = results[i].status === 'fulfilled' ? results[i].value : null;
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

  if (!extras.length) return null;

  onEvent({ type: 'synth_start' });
  const primaryLabel = MODELS[primaryKey]?.label || primaryKey;
  const synthMessages = [
    {
      role: 'system',
      content: 'Eres Adonix. Varios modelos analizaron la misma pregunta.\nCrea UNA SOLA respuesta final unificada.\nIntegra perspectivas unicas. Se directo. Responde en espanol.\nNO menciones que sintetizas ni que hay multiples modelos.',
    },
    {
      role: 'user',
      content: [
        `Respuesta de ${primaryLabel}:\n${primaryContent}`,
        ...extras.map(e => `\nRespuesta de ${e.label}:\n${e.content}`),
        '\nCrea la respuesta final unificada:',
      ].join('\n'),
    },
  ];

  try {
    let synthAnswer = '';
    await chat({
      messages: synthMessages,
      modelKey: primaryKey,
      onChunk: (delta, phase) => {
        if (isAborted?.()) return;
        if (phase !== 'thinking') {
          synthAnswer += delta;
          onEvent({ type: 'synth_delta', content: delta });
        }
      },
    });
    return synthAnswer.trim() || null;
  } catch {
    return null;
  }
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

  const toolCtx = {
    token: user.githubToken,
    owner: repoOwner,
    repo: repoName,
    email: user.githubEmail,
    authorName: user.githubUsername || user.githubName || user.username || 'Adonix',
    fileTree,
    onEvent,
  };
  const loopState = {
    autoActions: new Set(),
    lastFingerprint: '',
    repeatCount: 0,
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    if (isAborted?.()) return;

    let answer = '';
    let thinkingContent = '';
    let thinkStarted = false;
    let thinkStart = 0;
    let streamStarted = false;
    let isToolBuf = false;
    let isPlanBuf = false;

    try {
      const result = await chat({
        messages: modelMessages,
        modelKey,
        onChunk: (delta, phase) => {
          if (isAborted?.()) return;

          if (phase === 'thinking') {
            if (!thinkStarted) {
              thinkStarted = true;
              thinkStart = Date.now();
              onEvent({ type: 'thinking_start' });
            }
            thinkingContent += delta;
            onEvent({ type: 'thinking_delta', content: delta });
            return;
          }

          answer += delta;

          if (!streamStarted && !isToolBuf && !isPlanBuf) {
            if (looksLikeToolPayload(answer)) {
              isToolBuf = true;
              return;
            }

            if (looksLikeInternalPlan(answer)) {
              isPlanBuf = true;
              return;
            }

            const trimmed = answer.trimStart();
            if (trimmed.length < BUFFER_CHECK) return;

            streamStarted = true;
            onEvent({ type: 'delta', content: answer });
            return;
          }

          if (streamStarted) {
            onEvent({ type: 'delta', content: delta });
          }
        },
      });
      answer = result.answer || answer;
    } catch (err) {
      onEvent({ type: 'error', content: `Error del modelo: ${err.message}` });
      return;
    }

    if (thinkStarted) {
      const dur = ((Date.now() - thinkStart) / 1000).toFixed(1);
      onEvent({ type: 'thinking_end', duration: dur });
    }

    if (!String(answer || '').trim()) {
      if (streamStarted) onEvent({ type: 'clear_stream' });
      modelMessages.push({
        role: 'user',
        content: [
          'Terminaste de pensar pero no emitiste ninguna respuesta.',
          'Debes continuar ahora mismo.',
          'Si necesitas actuar, usa una herramienta.',
          'Si ya resolviste la tarea, responde solo con el resultado final.',
        ].join(' '),
      });
      continue;
    }

    const parsed = parseAgentResponse(answer);

    if (parsed.type === 'final' && looksLikeToolPayload(parsed.content || answer)) {
      if (streamStarted) onEvent({ type: 'clear_stream' });
      modelMessages.push({ role: 'assistant', content: answer });
      modelMessages.push({
        role: 'user',
        content: [
          'Tu ultima salida parecia un tool call JSON malformado o incompleto.',
          'No muestres JSON al usuario.',
          'Si necesitas una herramienta, responde SOLO con JSON valido.',
          'Si ya terminaste, responde SOLO con texto final limpio.',
        ].join(' '),
      });
      continue;
    }

    if (parsed.type === 'final' && looksLikeInternalPlan(parsed.content || answer)) {
      if (streamStarted) onEvent({ type: 'clear_stream' });
      const recovery = await attemptAutomaticRecovery(parsed.content || answer, history, toolCtx, loopState);
      if (recovery) {
        modelMessages.push({ role: 'assistant', content: recovery.assistant });
        for (const item of recovery.followUps) {
          modelMessages.push({ role: 'user', content: `TOOL_RESULT [${item.tool}]:\n${item.content}` });
        }
        continue;
      }
      modelMessages.push({ role: 'assistant', content: answer });
      modelMessages.push({
        role: 'user',
        content: [
          'Tu ultima salida fue un plan interno.',
          'No expliques tu plan al usuario.',
          'Si necesitas leer o editar, usa la herramienta correspondiente.',
          'Si ya terminaste, responde solo con el resultado final.',
          'Continua la tarea ahora.',
        ].join(' '),
      });
      continue;
    }

    if (parsed.type === 'final' && looksLikeDeferral(parsed.content || answer)) {
      if (streamStarted) onEvent({ type: 'clear_stream' });
      const recovery = await attemptAutomaticRecovery(parsed.content || answer, history, toolCtx, loopState);
      if (recovery) {
        modelMessages.push({ role: 'assistant', content: recovery.assistant });
        for (const item of recovery.followUps) {
          modelMessages.push({ role: 'user', content: `TOOL_RESULT [${item.tool}]:\n${item.content}` });
        }
        continue;
      }
      modelMessages.push({ role: 'assistant', content: answer });
      modelMessages.push({
        role: 'user',
        content: [
          'No pidas permiso ni delegues el siguiente paso.',
          'Busca los archivos necesarios con las herramientas disponibles, aplica el cambio y solo despues responde con el resultado final.',
          'Continua ahora.',
        ].join(' '),
      });
      continue;
    }

    if (parsed.type === 'final' && !String(parsed.content || '').trim()) {
      if (streamStarted) onEvent({ type: 'clear_stream' });
      modelMessages.push({ role: 'assistant', content: answer });
      modelMessages.push({
        role: 'user',
        content: [
          'Tu respuesta final quedo vacia.',
          'No la dejes vacia.',
          'Usa herramientas si hace falta o responde con el resultado final completo.',
          'Continua ahora.',
        ].join(' '),
      });
      continue;
    }

    const fingerprint = normalizeReplyFingerprint(parsed.content || answer);
    if (fingerprint) {
      if (loopState.lastFingerprint === fingerprint) {
        loopState.repeatCount += 1;
      } else {
        loopState.lastFingerprint = fingerprint;
        loopState.repeatCount = 1;
      }
    }

    if (parsed.type === 'final' && loopState.repeatCount >= 3) {
      if (streamStarted) onEvent({ type: 'clear_stream' });
      const recovery = await attemptAutomaticRecovery(parsed.content || answer, history, toolCtx, loopState);
      if (recovery) {
        modelMessages.push({ role: 'assistant', content: recovery.assistant });
        for (const item of recovery.followUps) {
          modelMessages.push({ role: 'user', content: `TOOL_RESULT [${item.tool}]:\n${item.content}` });
        }
        continue;
      }
    }

    // ── Final response ──
    if (parsed.type === 'final') {
      if (concuerdo) {
        const synthResult = await runConcuerdo(parsed.content, modelKey, modelMessages, onEvent, isAborted);
        if (synthResult) {
          chatData.messages.push({ role: 'assistant', content: synthResult, ts: Date.now() });
          store.saveChat(chatData);
          onEvent({ type: 'done', content: synthResult });
          return;
        }
      }

      chatData.messages.push({ role: 'assistant', content: parsed.content, ts: Date.now() });
      store.saveChat(chatData);
      onEvent({ type: 'done', content: parsed.content });
      return;
    }

    // ── Tool call ──
    if (parsed.type === 'tool') {
      if (streamStarted) onEvent({ type: 'clear_stream' });

      const toolResult = await executeTool(parsed.tool, parsed.args, toolCtx);
      modelMessages.push({ role: 'assistant', content: answer });
      modelMessages.push({ role: 'user', content: `TOOL_RESULT [${parsed.tool}]:\n${toolResult}` });
    }
  }

  onEvent({ type: 'error', content: 'Se alcanzo el limite de pasos.' });
}

module.exports = { runWebAgent };
