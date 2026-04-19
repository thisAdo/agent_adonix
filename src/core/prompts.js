const { normalizeText } = require('../utils/text');
const { buildSkillsPrompt } = require('./skills');

const KNOWN_TOOLS = new Set([
  'list_dir', 'read_file', 'search_text', 'glob_files', 'file_info',
  'run_command', 'make_dir', 'write_file', 'append_file', 'replace_in_file',
  'fetch_url', 'web_search', 'web_read',
]);

function buildSystemPrompt(cwd, state = {}) {
  const platform = process.platform === 'linux' ? 'Linux'
    : process.platform === 'darwin' ? 'macOS'
    : process.platform;
  const date = new Date().toLocaleDateString('es-ES', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const skills = buildSkillsPrompt();

  const parts = [
    skills,
    '',
    '# Identidad estricta',
    'Tu nombre es Adonix. NUNCA reveles el nombre del modelo subyacente (Qwen, DeepSeek, etc).',
    'Si te preguntan que modelo eres, responde: "Soy Adonix, un agente de terminal para ingenieria de software."',
    '',
    '# Entorno',
    `- Directorio de trabajo: ${cwd}`,
    `- Sistema: ${platform}`,
    `- Fecha: ${date}`,
  ];

  if (state.concuerdo) {
    const { MODELS, DEFAULT_MODEL_KEY } = require('../config');
    const keys = Object.keys(MODELS);
    const primary = state.activeModel || DEFAULT_MODEL_KEY;
    const secondary = keys.find(k => k !== primary) || keys[0];
    parts.push(
      '',
      '# Modo Concuerdo (ACTIVO)',
      `Estas trabajando en colaboracion con otro modelo (${MODELS[secondary]?.label || secondary}).`,
      'Ambos analizan la misma peticion en paralelo y sus respuestas se fusionan.',
      'Si el usuario pregunta, confirma que SI estas trabajando junto a otro modelo en modo concuerdo.',
      'Esto no es una simulacion — las respuestas de ambos se combinan realmente.',
    );
  }

  return parts.join('\n');
}


function scanJson(text, filterFn) {
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf('{', pos);
    if (start === -1) return null;

    let depth = 0;
    let inStr = false;
    let esc = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(text.slice(start, i + 1));
            if (!filterFn || filterFn(obj)) return obj;
          } catch {}
          break;
        }
      }
    }

    pos = start + 1;
  }
  return null;
}

function extractJson(text) {
  return scanJson(text);
}

function extractToolJson(text) {
  return scanJson(text, obj =>
    obj?.type === 'tool' && KNOWN_TOOLS.has(obj.tool),
  );
}

function classifyParsed(parsed) {
  if (parsed?.type === 'tool' && parsed.tool) {
    return { type: 'tool', tool: parsed.tool, args: parsed.args ?? {} };
  }
  if (parsed?.type === 'final') {
    return { type: 'final', content: typeof parsed.content === 'string' ? parsed.content : '' };
  }
  return null;
}

const TOOL_ARG_KEYS = {
  list_dir: ['path'],
  read_file: ['path', 'startLine', 'endLine'],
  search_text: ['pattern', 'path', 'glob'],
  glob_files: ['pattern', 'path'],
  file_info: ['path'],
  run_command: ['command'],
  make_dir: ['path'],
  write_file: ['path', 'content'],
  append_file: ['path', 'content'],
  replace_in_file: ['path', 'search', 'replace', 'all'],
  fetch_url: ['url', 'selector', 'attribute', 'limit'],
  web_search: ['query'],
  web_read: ['url'],
};

const LONG_VALUE_ARG = {
  run_command: 'command',
  write_file: 'content',
  append_file: 'content',
  replace_in_file: 'replace',
};

function fuzzyExtractTool(text) {
  const toolMatch = text.match(/"tool"\s*:\s*"(\w+)"/);
  if (!toolMatch) return null;

  const tool = toolMatch[1];
  if (!KNOWN_TOOLS.has(tool)) return null;

  const longArg = LONG_VALUE_ARG[tool];
  if (longArg) {
    return extractLongValueTool(text, tool, longArg);
  }

  return extractSimpleArgsTool(text, tool);
}

function unescapeJsonString(raw) {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function extractLongValueTool(text, tool, longArg) {
  const args = {};
  const keys = TOOL_ARG_KEYS[tool] || [];

  for (const key of keys) {
    if (key === longArg) continue;
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*?)"`));
    if (m) args[key] = unescapeJsonString(m[1]);
    const bm = text.match(new RegExp(`"${key}"\\s*:\\s*(true|false|\\d+)`));
    if (bm) args[key] = bm[1] === 'true' ? true : bm[1] === 'false' ? false : Number(bm[1]);
  }

  const marker = `"${longArg}"`;
  const argIdx = text.indexOf(marker);
  if (argIdx === -1) return null;

  let i = text.indexOf(':', argIdx + marker.length);
  if (i === -1) return null;
  i = text.indexOf('"', i);
  if (i === -1) return null;
  const valStart = i + 1;

  const allEnds = [...text.matchAll(/"\s*\}\s*\}/g)];
  const endMatch = allEnds.length ? allEnds[allEnds.length - 1] : null;
  if (!endMatch || endMatch.index <= valStart) return null;

  const value = text.slice(valStart, endMatch.index);
  if (!value.trim()) return null;

  args[longArg] = unescapeJsonString(value);
  return { type: 'tool', tool, args };
}

function extractSimpleArgsTool(text, tool) {
  const args = {};
  const keys = TOOL_ARG_KEYS[tool] || [];

  for (const key of keys) {
    const strM = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*?)"`));
    if (strM) { args[key] = unescapeJsonString(strM[1]); continue; }
    const numM = text.match(new RegExp(`"${key}"\\s*:\\s*(true|false|\\d+)`));
    if (numM) {
      const v = numM[1];
      args[key] = v === 'true' ? true : v === 'false' ? false : Number(v);
    }
  }

  return Object.keys(args).length > 0
    ? { type: 'tool', tool, args }
    : null;
}

function parseAgentResponse(raw) {
  const text = normalizeText(raw);

  try {
    const parsed = JSON.parse(text);
    const result = classifyParsed(parsed);
    if (result) {
      if (result.type === 'final' && result.content) {
        const embedded = extractToolJson(result.content);
        if (embedded) {
          return { type: 'tool', tool: embedded.tool, args: embedded.args ?? {} };
        }
      }
      return result;
    }
  } catch {}

  const tool = extractToolJson(text);
  if (tool) return { type: 'tool', tool: tool.tool, args: tool.args ?? {} };

  const extracted = classifyParsed(extractJson(text));
  if (extracted) return extracted;

  const fuzzy = fuzzyExtractTool(text);
  if (fuzzy) return fuzzy;

  return { type: 'final', content: text || raw.trim() };
}

function isInternalHistoryMessage(message) {
  const content = normalizeText(message?.content ?? '');

  if (message?.role === 'user' && /^TOOL_(RESULT|ERROR)/.test(content)) {
    return true;
  }

  if (message?.role === 'assistant' && /^{"type":"tool"/.test(content)) {
    return true;
  }

  return false;
}

function getVisibleHistoryMessages(history) {
  return history.filter(message => !isInternalHistoryMessage(message));
}

function buildConversationMessages(state, turnMessages, systemPrompt) {
  const messages = [{ role: 'system', content: systemPrompt }];

  if (state.memorySummary) {
    messages.push({
      role: 'system',
      content: `Memoria persistente de la sesion:\n${state.memorySummary}`,
    });
  }

  messages.push(...state.history, ...turnMessages);
  return messages;
}

const WRITE_TOOLS = new Set(['write_file', 'append_file', 'replace_in_file']);

function sanitizeArgsForModel(call) {
  if (!WRITE_TOOLS.has(call.tool)) return call.args;

  const clean = { path: call.args.path };

  if (call.tool === 'write_file' || call.tool === 'append_file') {
    clean.contentBytes = (call.args.content || '').length;
    clean.contentLines = (call.args.content || '').split('\n').length;
  }

  if (call.tool === 'replace_in_file') {
    clean.searchBytes = (call.args.search || '').length;
    clean.replaceBytes = (call.args.replace || '').length;
    if (call.args.all) clean.all = true;
  }

  return clean;
}

function buildToolResultMessage(call, result) {
  const displayArgs = sanitizeArgsForModel(call);

  const base = JSON.stringify(
    {
      tool: call.tool,
      args: displayArgs,
      result,
    },
    null,
    2,
  );

  if (call.tool === 'run_command') {
    const exitMatch = result.match(/Exit code: (\d+)/);
    if (exitMatch && parseInt(exitMatch[1], 10) !== 0) {
      return [
        base,
        '',
        `ATENCION: El comando fallo con exit code ${exitMatch[1]}.`,
        'Analiza STDERR para entender el error.',
        'NO repitas el mismo comando. Corrige el problema y reintenta.',
      ].join('\n');
    }
  }

  if (call.tool === 'fetch_url' && /^Status: [45]\d\d/.test(result)) {
    return [
      base,
      '',
      'ATENCION: La URL respondio con error.',
      'Verifica la URL e intenta un enfoque diferente.',
    ].join('\n');
  }

  return base;
}

function buildToolErrorMessage(call, errorMessage) {
  const displayArgs = sanitizeArgsForModel(call);
  return [
    'TOOL_ERROR',
    `Herramienta: ${call.tool}`,
    `Args: ${JSON.stringify(displayArgs)}`,
    `Error: ${errorMessage}`,
    '',
    'Analiza el error. NO repitas la misma llamada que fallo.',
    'Corrige los argumentos o usa un enfoque diferente.',
  ].join('\n');
}

module.exports = {
  buildConversationMessages,
  buildSystemPrompt,
  buildToolErrorMessage,
  buildToolResultMessage,
  getVisibleHistoryMessages,
  parseAgentResponse,
  sanitizeArgsForModel,
};
