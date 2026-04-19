const {
  ACTION_LOG_LIMIT,
  APP_NAME,
  DEFAULT_MODEL_KEY,
  MODELS,
  THINK_FRAMES,
} = require('../config');
const { shortText } = require('../utils/text');

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  white: '\x1b[97m',
  light: '\x1b[37m',
  gray: '\x1b[90m',
  darkGray: '\x1b[38;5;240m',
};

const INDENT = '    ';
const INDENT_LEN = 4;
const MAX_THINKING_LINES = 8;

function hasTTY() {
  return Boolean(process.stdout.isTTY || process.stderr.isTTY);
}

function c(text, ...styles) {
  if (!hasTTY()) return text;
  return styles.join('') + text + C.reset;
}

function contentWidth() {
  const cols = process.stdout.columns || 80;
  return Math.max(20, cols - 6);
}

function termWidth() {
  return contentWidth();
}

function wrapLines(text, maxWidth, indent = '') {
  const lines = [];
  const indentLen = indent.length;

  for (const rawLine of text.split('\n')) {
    if (!rawLine.length) {
      lines.push('');
      continue;
    }

    const words = rawLine.split(/(\s+)/);
    let line = '';
    let lineLen = indentLen;

    for (const word of words) {
      if (/^\s+$/.test(word)) {
        if (lineLen + word.length <= maxWidth) {
          line += word;
          lineLen += word.length;
        }
        continue;
      }

      if (lineLen + word.length > maxWidth && lineLen > indentLen) {
        lines.push(indent + line);
        line = '';
        lineLen = indentLen;
      }

      if (word.length > maxWidth - indentLen) {
        let remaining = word;
        while (remaining.length > 0) {
          const space = maxWidth - lineLen;
          const chunk = remaining.slice(0, space);
          line += chunk;
          lineLen += chunk.length;
          remaining = remaining.slice(space);
          if (remaining.length > 0) {
            lines.push(indent + line);
            line = '';
            lineLen = indentLen;
          }
        }
        continue;
      }

      line += word;
      lineLen += word.length;
    }

    lines.push(indent + line);
  }

  return lines;
}

function pushAction(state, kind, title, detail = '') {
  if (!state?.actionLog) return;
  state.actionLog.push({ at: new Date().toISOString(), kind, title, detail });
  if (state.actionLog.length > ACTION_LOG_LIMIT) state.actionLog.shift();
}

const EVENT_SYMBOLS = {
  info:  { sym: '·', color: C.gray },
  think: { sym: '○', color: C.gray },
  tool:  { sym: '▸', color: C.light },
  ok:    { sym: '✓', color: C.white },
  warn:  { sym: '!', color: C.light },
  error: { sym: '✗', color: C.light },
};

function logEvent(state, kind, title, detail = '') {
  pushAction(state, kind, title, detail);
  const ev = EVENT_SYMBOLS[kind] ?? EVENT_SYMBOLS.info;
  const sym = c(ev.sym, ev.color);
  const maxDetail = Math.max(10, contentWidth() - title.length - 6);
  const suffix = detail ? `  ${c(shortText(detail, maxDetail), C.gray)}` : '';
  console.error(`  ${sym} ${c(title, C.light)}${suffix}`);
}

function printDivider() {
  const w = Math.min(contentWidth(), 50);
  console.log(`  ${c('─'.repeat(w), C.darkGray)}`);
}

function printBanner(state) {
  const key = state.activeModel || DEFAULT_MODEL_KEY;
  const model = (MODELS[key]?.label || key).toLowerCase();

  console.log('');
  console.log(`  ${c('◆', C.white)} ${c(APP_NAME, C.bold, C.white)}  ${c('·', C.darkGray)}  ${c(model, C.gray)}`);
  console.log(`  ${c('/help para comandos', C.darkGray)}`);
  console.log('');
}

async function printWelcome() {
  if (!process.stdout.isTTY) return;

  const label = c(APP_NAME, C.bold, C.white);

  for (let i = 0; i < THINK_FRAMES.length; i++) {
    process.stdout.write(`\r  ${c(THINK_FRAMES[i], C.gray)} ${label}`);
    await sleep(40);
  }

  process.stdout.write(`\r  ${c('◆', C.white)} ${label}\n`);
}

function printAssistantMessage(content) {
  const width = contentWidth();
  const wrapped = wrapLines(content, width - INDENT_LEN);

  console.log('');
  if (wrapped.length > 0) {
    console.log(`  ${c('◆', C.white)} ${c(wrapped[0].trimStart(), C.white)}`);
    for (let i = 1; i < wrapped.length; i++) {
      console.log(`${INDENT}${c(wrapped[i], C.white)}`);
    }
  }
  console.log('');
}

function startThinkingIndicator(state, label) {
  pushAction(state, 'think', label);

  if (!process.stderr.isTTY) {
    console.error(`  ${c('○', C.gray)} ${label}`);
    return () => {};
  }

  let idx = 0;
  let active = true;

  const render = () => {
    const frame = THINK_FRAMES[idx % THINK_FRAMES.length];
    process.stderr.write(`\r  ${c(frame, C.gray)} ${c(label, C.gray)}`);
    idx++;
  };

  render();
  const timer = setInterval(render, 80);

  return () => {
    if (!active) return;
    active = false;
    clearInterval(timer);
    process.stderr.write('\r\x1b[2K');
  };
}

function beginThinkingStream(state) {
  if (state.thinkingStream?.active) return;

  if (!process.stderr.isTTY) {
    state.thinkingStream = { active: true, plain: true };
    return;
  }

  const frozenWidth = contentWidth();
  process.stderr.write(`  ${c('○', C.gray)} ${c('pensando...', C.dim, C.italic)}\n`);
  state.thinkingStream = {
    active: true,
    plain: false,
    col: 0,
    linesDown: 1,
    visibleLines: 0,
    started: Date.now(),
    maxWidth: frozenWidth,
  };
}

function writeThinkingDelta(state, delta) {
  if (!delta || !state.thinkingStream?.active || state.thinkingStream.plain) return;

  const maxLines = MAX_THINKING_LINES;
  if (state.thinkingStream.visibleLines >= maxLines) return;

  const maxCol = state.thinkingStream.maxWidth;
  const prefixRaw = `  ${c('│', C.darkGray)} `;
  const prefixLen = 4;
  let { col, linesDown, visibleLines } = state.thinkingStream;
  let buf = '';

  for (const ch of delta) {
    if (visibleLines >= maxLines) {
      if (buf) {
        process.stderr.write(c(buf, C.dim, C.gray));
        buf = '';
      }
      process.stderr.write(c('...', C.darkGray));
      break;
    }

    if (ch === '\n') {
      if (buf) { process.stderr.write(c(buf, C.dim, C.gray)); buf = ''; }
      process.stderr.write('\n');
      linesDown++;
      visibleLines++;
      col = 0;
      continue;
    }

    if (col === 0) {
      if (buf) { process.stderr.write(c(buf, C.dim, C.gray)); buf = ''; }
      process.stderr.write(prefixRaw);
      col = prefixLen;
    }

    if (col >= maxCol) {
      if (buf) { process.stderr.write(c(buf, C.dim, C.gray)); buf = ''; }
      process.stderr.write('\n');
      linesDown++;
      visibleLines++;
      if (visibleLines >= maxLines) {
        process.stderr.write(`  ${c('│', C.darkGray)} ${c('...', C.darkGray)}`);
        break;
      }
      process.stderr.write(prefixRaw);
      col = prefixLen;
      if (ch === ' ') continue;
    }

    buf += ch;
    col++;
  }

  if (buf) process.stderr.write(c(buf, C.dim, C.gray));
  Object.assign(state.thinkingStream, { col, linesDown, visibleLines });
}

function endThinkingStream(state) {
  if (!state.thinkingStream?.active) return;

  if (!state.thinkingStream.plain) {
    if (state.thinkingStream.col > 0) {
      process.stderr.write('\n');
      state.thinkingStream.linesDown++;
    }

    for (let i = 0; i < state.thinkingStream.linesDown; i++) {
      process.stderr.write('\x1b[A\r\x1b[2K');
    }

    const elapsed = ((Date.now() - state.thinkingStream.started) / 1000).toFixed(1);
    process.stderr.write(`  ${c('○', C.gray)} ${c(`pensó ${elapsed}s`, C.dim, C.gray)}\n`);
  }

  state.thinkingStream = null;
}

function beginAssistantStream(state) {
  if (state.liveResponse?.active) return;

  if (!process.stdout.isTTY) {
    state.liveResponse = { active: true, streamed: false, plain: true };
    return;
  }

  const frozenWidth = contentWidth();
  console.log('');
  process.stdout.write(`  ${c('◆', C.white)} `);
  state.liveResponse = {
    active: true,
    streamed: false,
    plain: false,
    col: INDENT_LEN,
    maxWidth: frozenWidth,
  };
}

function writeAssistantDelta(state, delta) {
  if (!delta) return;
  if (!state.liveResponse?.active) beginAssistantStream(state);
  state.liveResponse.streamed = true;

  if (state.liveResponse.plain) {
    process.stdout.write(delta);
    return;
  }

  const maxCol = state.liveResponse.maxWidth;
  let { col } = state.liveResponse;
  let wordBuf = state.liveResponse.wordBuf || '';

  function flushWord() {
    if (!wordBuf) return;
    if (col + wordBuf.length > maxCol && col > INDENT_LEN) {
      process.stdout.write('\n' + INDENT);
      col = INDENT_LEN;
    }
    process.stdout.write(c(wordBuf, C.white));
    col += wordBuf.length;
    wordBuf = '';
  }

  for (const ch of delta) {
    if (ch === '\n') {
      flushWord();
      process.stdout.write('\n' + INDENT);
      col = INDENT_LEN;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      flushWord();
      if (col < maxCol) {
        process.stdout.write(ch === '\t' ? '  ' : ' ');
        col += ch === '\t' ? 2 : 1;
      }
      continue;
    }

    wordBuf += ch;

    if (wordBuf.length >= maxCol - INDENT_LEN) {
      flushWord();
    }
  }

  state.liveResponse.col = col;
  state.liveResponse.wordBuf = wordBuf;
}

function endAssistantStream(state) {
  if (!state.liveResponse?.active) return;
  process.stdout.write(state.liveResponse.plain ? '\n' : '\n\n');
  state.liveResponse = null;
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function streamBufferedAssistantMessage(state, content) {
  beginAssistantStream(state);

  if (!process.stdout.isTTY) {
    writeAssistantDelta(state, content);
    endAssistantStream(state);
    return;
  }

  const tokens = content.split(/(\s+)/);
  let buf = '';
  for (const token of tokens) {
    buf += token;
    if (buf.length >= 12 || token.includes('\n')) {
      writeAssistantDelta(state, buf);
      buf = '';
      await sleep(8);
    }
  }
  if (buf) writeAssistantDelta(state, buf);

  endAssistantStream(state);
}

function printStatus(state) {
  const key = state.activeModel || DEFAULT_MODEL_KEY;
  const model = MODELS[key]?.label || key;

  const rows = [
    ['sesion', state.sessionId],
    ['titulo', state.title],
    ['modelo', model],
    ['cwd', state.cwd],
    ['auto', state.autoApprove ? 'on' : 'off'],
    ['turnos', String(state.turnCount)],
    ['mensajes', String(state.history.length)],
    ['memoria', state.memorySummary ? 'si' : 'no'],
  ];

  console.log('');
  for (const [label, value] of rows) {
    console.log(`  ${c(label.padEnd(10), C.gray)} ${c(value, C.white)}`);
  }
  console.log('');
}

function printHistory(state) {
  if (state.actionLog.length === 0) {
    console.log(`  ${c('Sin acciones registradas.', C.gray)}`);
    return;
  }

  console.log('');
  for (const item of state.actionLog.slice(-15)) {
    const time = c(item.at.slice(11, 19), C.darkGray);
    const detail = item.detail ? `  ${c(item.detail, C.gray)}` : '';
    console.log(`  ${time}  ${c(item.title, C.light)}${detail}`);
  }
  console.log('');
}

function printMemory(state) {
  if (!state.memorySummary) {
    console.log(`  ${c('Sin memoria compactada.', C.gray)}`);
    return;
  }

  const width = contentWidth();
  const wrapped = wrapLines(state.memorySummary, width - INDENT_LEN, INDENT);

  console.log('');
  for (const line of wrapped) {
    console.log(c(line, C.light));
  }
  console.log('');
}

function printSession(state) {
  const rows = [
    ['sesion', state.sessionId],
    ['titulo', state.title],
    ['archivo', state.sessionPath],
    ['transcript', state.transcriptPath],
    ['desde', state.createdAt],
    ['update', state.updatedAt],
  ];

  console.log('');
  for (const [label, value] of rows) {
    console.log(`  ${c(label.padEnd(12), C.gray)} ${c(value, C.light)}`);
  }
  console.log('');
}

function printSessions(sessions) {
  if (sessions.length === 0) {
    console.log(`  ${c('No hay sesiones guardadas.', C.gray)}`);
    return;
  }

  console.log('');
  for (const s of sessions.slice(0, 15)) {
    const id = c(s.sessionId.replace('adonix-', ''), C.darkGray);
    const turns = c(`${s.turnCount}t`, C.gray);
    const title = shortText(s.title, 40);
    console.log(`  ${id}  ${turns}  ${c(title, C.light)}`);
  }
  console.log('');
}

function paint(text, color) {
  const map = {
    cyan: C.white,
    green: C.white,
    yellow: C.light,
    red: C.light,
    magenta: C.gray,
    dim: C.gray,
    bold: C.bold,
  };
  return c(text, map[color] || '');
}

module.exports = {
  beginAssistantStream,
  beginThinkingStream,
  contentWidth,
  endAssistantStream,
  endThinkingStream,
  logEvent,
  paint,
  printAssistantMessage,
  printBanner,
  printDivider,
  printHistory,
  printMemory,
  printSession,
  printSessions,
  printStatus,
  printWelcome,
  pushAction,
  shortText,
  startThinkingIndicator,
  streamBufferedAssistantMessage,
  termWidth,
  writeAssistantDelta,
  writeThinkingDelta,
};
