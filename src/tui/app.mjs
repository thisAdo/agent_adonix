import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, Static, useInput, useApp, useStdout } from 'ink';
import { createRequire } from 'module';
import { EventEmitter } from 'events';

const require = createRequire(import.meta.url);
const { runAgentTurn } = require('../core/agent');
const { handleLocalCommand, SLASH_COMMANDS } = require('../cli/commands');
const {
  loadOrCreateSessionState,
  applyLoadedState,
} = require('../utils/sessionStorage');
const { appendTranscriptEntry } = require('../utils/transcriptStorage');
const { pushAction } = require('../cli/print');
const {
  APP_NAME,
  DEFAULT_MODEL_KEY,
  MODELS,
} = require('../config');

const h = React.createElement;
const MAX_THINKING_LINES = 20;
const SPIN_MS = 80;

const SPIN_FRAMES = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];

const T = {
  bg:          '#0d0d0d',
  surface:     '#1a1a1a',
  surfaceHi:   '#222222',
  text:        '#ffffff',
  textDim:     '#cccccc',
  textMuted:   '#999999',
  textGhost:   '#666666',
  textInvis:   '#333333',
  accent:      '#d4a054',
  accentSoft:  '#c49450',
  accentDim:   '#8a6a3a',
  green:       '#6aab6a',
  greenDim:    '#3a6a3a',
  red:         '#cc5555',
  redDim:      '#6a3333',
  amber:       '#ccaa44',
  amberDim:    '#6a5522',
  purple:      '#aa88cc',
  purpleDim:   '#5a446a',
  blue:        '#6699cc',
  blueDim:     '#334466',
  cyan:        '#66cccc',
  cyanDim:     '#336666',
  border:      '#2a2a2a',
  borderLight: '#383838',
  codeBg:      '#111111',
};

class UIStore extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.items = [];
    this.liveThinking = null;
    this.liveAnswer = null;
    this.spinner = null;
    this.processing = false;
    this.confirmRequest = null;
    this.turnCount = 0;
    this.messageQueue = [];
    this.pendingExit = false;
    this._idCounter = 0;
    this._scheduled = false;
  }

  addItem(item) {
    this._idCounter += 1;
    this.items = [...this.items, { ...item, id: String(this._idCounter) }];
    this._emit();
  }

  setSpinner(label) {
    this.spinner = label ? { label, started: Date.now() } : null;
    this._emit();
  }

  beginThinking() {
    this.liveThinking = { text: '', started: Date.now() };
    this._emit();
  }

  appendThinking(delta) {
    if (!this.liveThinking) return;
    this.liveThinking = { ...this.liveThinking, text: this.liveThinking.text + delta };
    this._emit();
  }

  endThinking() {
    if (!this.liveThinking) return;
    const elapsed = ((Date.now() - this.liveThinking.started) / 1000).toFixed(1);
    this.addItem({ type: 'thinking', text: this.liveThinking.text, elapsed });
    this.liveThinking = null;
  }

  beginAnswer() {
    this.liveAnswer = { text: '' };
    this._emit();
  }

  appendAnswer(delta) {
    if (!this.liveAnswer) return;
    this.liveAnswer = { ...this.liveAnswer, text: this.liveAnswer.text + delta };
    this._emit();
  }

  endAnswer() {
    if (!this.liveAnswer) return;
    this.addItem({ type: 'answer', text: this.liveAnswer.text });
    this.liveAnswer = null;
  }

  addEvent(kind, title, detail) {
    this.addItem({ type: 'event', kind, title, detail: detail || '' });
  }

  requestConfirm(title, detail) {
    return new Promise(resolve => {
      this.confirmRequest = { title, detail, resolve };
      this._emit();
    });
  }

  resolveConfirm(answer) {
    if (!this.confirmRequest) return;
    this.confirmRequest.resolve(answer);
    this.confirmRequest = null;
    this._emit();
  }

  enqueueMessage(text) {
    this.messageQueue.push(text);
    this.addItem({ type: 'queued', text });
    this._emit();
  }

  _emit() {
    if (this._scheduled) return;
    this._scheduled = true;
    setImmediate(() => {
      this._scheduled = false;
      this.emit('update');
    });
  }
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + (s % 60) + 's';
}

function useStore(store) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const handler = () => setTick(t => t + 1);
    store.on('update', handler);
    return () => store.off('update', handler);
  }, [store]);
}

function useDimensions() {
  const { stdout } = useStdout();
  const [dims, setDims] = useState({ width: stdout?.columns || 100, height: stdout?.rows || 40 });
  useEffect(() => {
    if (!stdout) return;
    const handler = () => {
      setDims({ width: stdout.columns || 100, height: stdout.rows || 40 });
    };
    stdout.on('resize', handler);
    return () => stdout.off('resize', handler);
  }, [stdout]);
  return dims;
}


function parseInline(text) {
  const parts = [];
  const regex = /(\*\*(.+?)\*\*)|(`(.+?)`)/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ t: 'text', v: text.slice(lastIndex, match.index) });
    }
    if (match[2]) parts.push({ t: 'bold', v: match[2] });
    else if (match[4]) parts.push({ t: 'code', v: match[4] });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push({ t: 'text', v: text.slice(lastIndex) });
  }
  if (parts.length === 0) parts.push({ t: 'text', v: text });
  return parts;
}

function InlineLine({ text, color }) {
  const parts = parseInline(text);
  const base = color || T.text;
  return h(Box, { flexWrap: 'wrap' },
    ...parts.map((p, i) => {
      if (p.t === 'bold') return h(Text, { key: String(i), color: base, bold: true }, p.v);
      if (p.t === 'code') return h(Text, { key: String(i), color: T.cyan, backgroundColor: T.codeBg }, ' ' + p.v + ' ');
      return h(Text, { key: String(i), color: base }, p.v);
    }),
  );
}

function parseMarkdownBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') });
      continue;
    }
    const hMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (hMatch) {
      blocks.push({ type: 'header', level: hMatch[1].length, text: hMatch[2] });
      i++;
      continue;
    }
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)/);
    if (ulMatch) {
      blocks.push({ type: 'list', indent: Math.floor(ulMatch[1].length / 2), text: ulMatch[2] });
      i++;
      continue;
    }
    const olMatch = line.match(/^(\s*)\d+[.)]\s+(.+)/);
    if (olMatch) {
      blocks.push({ type: 'list', indent: Math.floor(olMatch[1].length / 2), text: olMatch[2], ordered: true });
      i++;
      continue;
    }
    blocks.push({ type: 'text', text: line });
    i++;
  }
  return blocks;
}

function CodeBlock({ lang, code, width }) {
  const maxW = Math.max(20, Math.min((width || 80) - 4, 90));
  const inner = maxW - 4;
  const langLabel = lang ? ' ' + lang + ' ' : '';
  const topBar = '\u250c' + (langLabel ? '\u2500' + langLabel : '') + '\u2500'.repeat(Math.max(0, maxW - 2 - langLabel.length)) + '\u2510';
  const botBar = '\u2514' + '\u2500'.repeat(maxW - 2) + '\u2518';
  const codeLines = code.split('\n');

  return h(Box, { flexDirection: 'column', marginTop: 0, marginBottom: 0 },
    h(Text, { color: T.borderLight }, topBar),
    ...codeLines.map((ln, i) => {
      const padded = ln.length > inner ? ln.slice(0, inner) : ln + ' '.repeat(Math.max(0, inner - ln.length));
      return h(Box, { key: String(i) },
        h(Text, { color: T.borderLight }, '\u2502 '),
        h(Text, { color: T.cyan }, padded),
        h(Text, { color: T.borderLight }, ' \u2502'),
      );
    }),
    h(Text, { color: T.borderLight }, botBar),
  );
}

function MarkdownContent({ text, width }) {
  const blocks = parseMarkdownBlocks(text);
  return h(Box, { flexDirection: 'column' },
    ...blocks.map((block, i) => {
      switch (block.type) {
        case 'code':
          return h(CodeBlock, { key: String(i), lang: block.lang, code: block.code, width });
        case 'header':
          return h(Box, { key: String(i), marginTop: block.level === 1 ? 1 : 0 },
            h(Text, { color: T.accent, bold: true }, block.text),
          );
        case 'list': {
          const pad = '  '.repeat(block.indent || 0);
          const bullet = block.ordered ? '  ' : '  \u2022 ';
          return h(Box, { key: String(i) },
            h(Text, { color: T.textMuted }, pad + bullet),
            h(InlineLine, { text: block.text }),
          );
        }
        case 'text':
          return block.text.trim()
            ? h(Box, { key: String(i) }, h(InlineLine, { text: block.text }))
            : h(Box, { key: String(i), height: 1 });
        default:
          return null;
      }
    }),
  );
}


function Banner({ model, resumed, width, cwd }) {
  const maxW = Math.max(30, Math.min(width - 4, 72));
  const inner = maxW - 4;
  const topLine = '  \u250c' + '\u2500'.repeat(maxW - 2) + '\u2510';
  const botLine = '  \u2514' + '\u2500'.repeat(maxW - 2) + '\u2518';

  const pad = (str) => {
    const s = str.slice(0, inner);
    return s + ' '.repeat(Math.max(0, inner - s.length));
  };

  const sessionLabel = resumed ? 'sesion reanudada' : 'sesion nueva';
  const cwdShort = cwd && cwd.length > inner - 6 ? '...' + cwd.slice(-(inner - 9)) : (cwd || '.');

  return h(Box, { flexDirection: 'column', paddingTop: 1, paddingBottom: 0 },
    h(Text, { color: T.border }, topLine),
    h(Box, {},
      h(Text, { color: T.border }, '  \u2502 '),
      h(Text, { color: T.accent, bold: true }, '\u25cf '),
      h(Text, { color: T.text, bold: true }, pad(APP_NAME)),
      h(Text, { color: T.border }, ' \u2502'),
    ),
    h(Box, {},
      h(Text, { color: T.border }, '  \u2502 '),
      h(Text, { color: T.textMuted }, pad('modelo: ' + model + ' \u00b7 ' + sessionLabel)),
      h(Text, { color: T.border }, ' \u2502'),
    ),
    h(Box, {},
      h(Text, { color: T.border }, '  \u2502 '),
      h(Text, { color: T.textMuted }, pad('cwd: ' + cwdShort)),
      h(Text, { color: T.border }, ' \u2502'),
    ),
    h(Text, { color: T.border }, botLine),
  );
}

function SpinnerLine({ label, started }) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPIN_FRAMES.length);
      if (started) setElapsed(Date.now() - started);
    }, SPIN_MS);
    return () => clearInterval(timer);
  }, [started]);

  const elapsedStr = elapsed > 1500 ? formatElapsed(elapsed) : '';

  return h(Box, { paddingLeft: 5, gap: 1 },
    h(Text, { color: T.accentSoft }, SPIN_FRAMES[frame]),
    h(Text, { color: T.textMuted }, label),
    elapsedStr ? h(Text, { color: T.textGhost }, elapsedStr) : null,
  );
}

function EventLine({ kind, title, detail }) {
  const cfg = {
    info:    { sym: '\u00b7', color: T.textGhost },
    think:   { sym: '\u25d0', color: T.textGhost },
    tool:    { sym: '\u2933', color: T.purple },
    ok:      { sym: '\u2713', color: T.green },
    warn:    { sym: '\u25b2', color: T.amber },
    error:   { sym: '\u2715', color: T.red },
  };
  const { sym, color } = cfg[kind] || cfg.info;

  return h(Box, { paddingLeft: 5, gap: 1 },
    h(Text, { color }, sym),
    h(Text, { color: kind === 'tool' ? T.textDim : T.textMuted }, title),
    detail ? h(Text, { color: T.textGhost }, detail) : null,
  );
}

function UserMessage({ text }) {
  return h(Box, { paddingLeft: 3, paddingRight: 3, marginTop: 1, marginBottom: 0, flexDirection: 'row' },
    h(Box, { flexDirection: 'column' },
      h(Box, { gap: 1, marginBottom: 0 },
        h(Text, { color: T.accent, bold: true }, '\u29bf'),
        h(Text, { color: T.textDim, bold: true }, 'You'),
      ),
      h(Box, { paddingLeft: 2 },
        h(Text, { color: T.text, wrap: 'wrap' }, text),
      ),
    ),
  );
}

function ThinkingBlock({ text, elapsed, live, width }) {
  const lines = text.split('\n').filter(l => l.trim()).slice(0, MAX_THINKING_LINES);
  const total  = text.split('\n').filter(l => l.trim()).length;
  const more   = total - MAX_THINKING_LINES;

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick(n => n + 1), 200);
    return () => clearInterval(t);
  }, [live]);

  const pulseChar = live ? SPIN_FRAMES[Math.floor(Date.now() / SPIN_MS) % SPIN_FRAMES.length] : '\u25d0';

  const label = live
    ? pulseChar + '  pensando...'
    : '\u25d0  penso ' + elapsed + 's';

  return h(Box, { flexDirection: 'column', paddingLeft: 5, marginTop: 1 },
    h(Text, { color: T.textGhost }, label),
    lines.length > 0
      ? h(Box, { flexDirection: 'column', paddingLeft: 2 },
          ...lines.map((line, i) =>
            h(Text, { key: String(i), color: T.textInvis, wrap: 'wrap' }, line),
          ),
          more > 0 ? h(Text, { color: T.textGhost }, '\u00b7\u00b7\u00b7 ' + more + ' lineas mas') : null,
        )
      : null,
  );
}

function AnswerBlock({ text, live, width }) {
  if (!text) return null;
  return h(Box, { flexDirection: 'column', paddingLeft: 3, paddingRight: 3, marginTop: 1 },
    h(Box, { gap: 1, marginBottom: 0 },
      h(Text, { color: T.accentSoft, bold: true }, '\u25c9'),
      h(Text, { color: T.textDim, bold: true }, APP_NAME),
    ),
    h(Box, { flexDirection: 'column', paddingLeft: 2 },
      h(MarkdownContent, { text, width: Math.max(40, (width || 80) - 8) }),
      live ? h(Text, { color: T.accent }, '\u258e') : null,
    ),
  );
}

function SystemMsg({ text }) {
  return h(Box, { flexDirection: 'column', paddingLeft: 5 },
    ...text.split('\n').map((line, i) =>
      h(Text, { key: String(i), color: T.textMuted, wrap: 'wrap' }, line),
    ),
  );
}

function QueuedMessage({ text }) {
  return h(Box, { paddingLeft: 5, gap: 1, marginTop: 0 },
    h(Text, { color: T.amber }, '\u{1F4E9}'),
    h(Text, { color: T.textGhost, italic: true, wrap: 'wrap' }, text),
  );
}

function ConfirmBar({ title, detail }) {
  const detailLines = (detail || '').split('\n').filter(l => l.trim()).slice(0, 10);

  return h(Box, { flexDirection: 'column', paddingLeft: 3, marginTop: 1 },
    h(Box, { gap: 1 },
      h(Text, { color: T.amber, bold: true }, '\u26a0'),
      h(Text, { color: T.text, bold: true }, title),
    ),
    detailLines.length > 0
      ? h(Box, {
          flexDirection: 'column',
          paddingLeft: 2,
          marginTop: 0,
          borderStyle: 'single',
          borderColor: T.border,
          paddingRight: 1,
        },
          ...detailLines.map((line, i) =>
            h(Text, { key: String(i), color: T.textDim, wrap: 'wrap' }, line),
          ),
        )
      : null,
    h(Box, { marginTop: 0, paddingLeft: 2, gap: 2 },
      h(Text, { color: T.green, bold: true }, '[y]'),
      h(Text, { color: T.textMuted }, 'permitir'),
      h(Text, { color: T.textInvis }, '\u00b7'),
      h(Text, { color: T.red, bold: true }, '[n]'),
      h(Text, { color: T.textMuted }, 'denegar'),
    ),
  );
}

function StatusBar({ model, processing, width, turnCount }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => setFrame(f => (f + 1) % SPIN_FRAMES.length), SPIN_MS);
    return () => clearInterval(t);
  }, [processing]);

  const line = '\u2500'.repeat(Math.max(10, Math.min(width - 4, 120)));
  const safeW = Math.max(width - 2, 20);

  return h(Box, { flexDirection: 'column', paddingLeft: 1, paddingRight: 1 },
    h(Box, {},
      h(Text, { color: T.border }, line),
    ),
    h(Box, { paddingLeft: 1, paddingTop: 0, gap: 1, justifyContent: 'space-between', width: safeW },
      h(Box, { gap: 1 },
        h(Text, { color: T.accent }, '\u25cf'),
        h(Text, { color: T.textGhost }, model),
        processing
          ? h(Text, { color: T.accentSoft }, SPIN_FRAMES[frame])
          : null,
        turnCount > 0
          ? h(Text, { color: T.textInvis }, '\u00b7 ' + turnCount + (turnCount === 1 ? ' turno' : ' turnos'))
          : null,
      ),
      h(Box, { gap: 1 },
        h(Text, { color: T.textInvis }, '/help'),
        h(Text, { color: T.textInvis }, '\u00b7'),
        h(Text, { color: T.textInvis }, 'esc salir'),
      ),
    ),
  );
}

function StaticItem({ item, width }) {
  switch (item.type) {
    case 'banner':   return h(Banner,        { model: item.model, resumed: item.resumed, width, cwd: item.cwd });
    case 'divider':  return h(Box, { paddingLeft: 2 }, h(Text, { color: T.textInvis }, ' '));
    case 'user':     return h(UserMessage,   { text: item.text });
    case 'thinking': return h(ThinkingBlock, { text: item.text, elapsed: item.elapsed, width });
    case 'answer':   return h(AnswerBlock,   { text: item.text, width });
    case 'event':    return h(EventLine,     { kind: item.kind, title: item.title, detail: item.detail });
    case 'system':   return h(SystemMsg,     { text: item.text });
    case 'queued':   return h(QueuedMessage, { text: item.text });
    default:         return null;
  }
}

function InputBar({ onSubmit, processing }) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [histIdx, setHistIdx] = useState(-1);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const historyRef = useRef([]);
  const savedRef = useRef('');

  const showSuggestions = value.startsWith('/') && !value.includes(' ') && value.length > 0;
  const suggestions = showSuggestions
    ? SLASH_COMMANDS.filter(c => ('/' + c.name).startsWith(value.toLowerCase()))
    : [];

  useInput((input, key) => {
    if (key.return) {
      const text = value.trim();
      if (!text) return;
      historyRef.current.unshift(text);
      if (historyRef.current.length > 100) historyRef.current.pop();
      setValue('');
      setCursor(0);
      setHistIdx(-1);
      setSuggestIdx(0);
      onSubmit(text);
      return;
    }

    if (key.tab && suggestions.length > 0) {
      const cmd = suggestions[suggestIdx] || suggestions[0];
      if (cmd) {
        const completed = `/${cmd.name} `;
        setValue(completed);
        setCursor(completed.length);
        setSuggestIdx(0);
      }
      return;
    }

    if (showSuggestions && suggestions.length > 0) {
      if (key.upArrow) {
        setSuggestIdx(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSuggestIdx(i => Math.min(suggestions.length - 1, i + 1));
        return;
      }
    }

    if (key.upArrow) {
      const hist = historyRef.current;
      if (hist.length === 0) return;
      if (histIdx === -1) savedRef.current = value;
      const next = Math.min(histIdx + 1, hist.length - 1);
      setHistIdx(next);
      setValue(hist[next]);
      setCursor(hist[next].length);
      return;
    }

    if (key.downArrow) {
      if (histIdx <= 0) {
        setHistIdx(-1);
        setValue(savedRef.current);
        setCursor(savedRef.current.length);
        return;
      }
      const next = histIdx - 1;
      setHistIdx(next);
      setValue(historyRef.current[next]);
      setCursor(historyRef.current[next].length);
      return;
    }

    if (key.leftArrow) {
      setCursor(c => Math.max(0, c - 1));
      return;
    }

    if (key.rightArrow) {
      setCursor(c => Math.min(value.length, c + 1));
      return;
    }

    if (key.ctrl && input === 'a') { setCursor(0); return; }
    if (key.ctrl && input === 'e') { setCursor(value.length); return; }

    if (key.ctrl && input === 'u') {
      const after = value.slice(cursor);
      setValue(after);
      setCursor(0);
      return;
    }

    if (key.ctrl && input === 'w') {
      const before = value.slice(0, cursor);
      const after = value.slice(cursor);
      const trimmed = before.replace(/\S+\s*$/, '');
      setValue(trimmed + after);
      setCursor(trimmed.length);
      return;
    }

    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setValue(v => v.slice(0, cursor - 1) + v.slice(cursor));
      setCursor(c => Math.max(0, c - 1));
      setSuggestIdx(0);
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setValue(v => v.slice(0, cursor) + input + v.slice(cursor));
      setCursor(c => c + input.length);
      setSuggestIdx(0);
    }
  });

  const hasText = value.length > 0;
  const before = value.slice(0, cursor);
  const cursorChar = value[cursor] || ' ';
  const after = value.slice(cursor + 1);

  const promptColor = processing ? T.amber : T.accent;
  const placeholder = processing ? ' En cola — escribe y se procesará después...' : ' Escribe un mensaje...';

  const inputLine = h(Box, { paddingLeft: 3, paddingRight: 3, paddingTop: 0, paddingBottom: 0, marginTop: 1 },
    h(Text, { color: promptColor }, processing ? '\u{1F4E9} ' : '\u276f '),
    hasText
      ? h(Box, {},
          h(Text, { color: T.text }, before),
          h(Text, { color: promptColor, inverse: true }, cursorChar),
          after ? h(Text, { color: T.text }, after) : null,
        )
      : h(Box, {},
          h(Text, { color: promptColor, inverse: true }, ' '),
          h(Text, { color: T.textGhost }, placeholder),
        ),
  );

  if (suggestions.length === 0) return inputLine;

  const maxVisible = 8;
  const safeIdx = Math.min(suggestIdx, suggestions.length - 1);
  const windowStart = Math.max(0, Math.min(safeIdx - maxVisible + 1, suggestions.length - maxVisible));
  const visible = suggestions.slice(windowStart, windowStart + maxVisible);
  const hasMore = suggestions.length > maxVisible;

  return h(Box, { flexDirection: 'column' },
    inputLine,
    h(Box, { flexDirection: 'column', paddingLeft: 5, marginTop: 0 },
      hasMore && windowStart > 0
        ? h(Text, { color: T.textInvis }, '  \u2191 mas')
        : null,
      ...visible.map((cmd, i) => {
        const realIdx = windowStart + i;
        const selected = realIdx === safeIdx;
        return h(Box, { key: cmd.name },
          h(Text, {
            color: selected ? T.accent : T.textMuted,
            bold: selected,
          }, selected ? '\u25b8 ' : '  '),
          h(Text, {
            color: selected ? T.accent : T.textMuted,
          }, `/${cmd.name}`),
          h(Text, { color: T.textGhost }, `  ${cmd.desc}`),
        );
      }),
      hasMore && windowStart + maxVisible < suggestions.length
        ? h(Text, { color: T.textInvis }, '  \u2193 mas')
        : null,
      h(Box, { paddingTop: 0 },
        h(Text, { color: T.textInvis }, 'Tab completar \u00b7 \u2191\u2193 navegar'),
      ),
    ),
  );
}

function App({ store, state, onSubmit }) {
  useStore(store);
  const { exit } = useApp();
  const { width } = useDimensions();

  const modelKey   = state?.activeModel || DEFAULT_MODEL_KEY;
  const modelLabel = (MODELS[modelKey]?.label || modelKey).toLowerCase();

  const handleInput = useCallback((text) => {
    if (text === '/exit' || text === '/quit') {
      if (store.processing) {
        store.pendingExit = true;
        store.addEvent('info', 'saliendo al terminar el turno actual');
        return;
      }
      exit();
      return;
    }
    onSubmit(text);
  }, [onSubmit, exit, store]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return; }
    if (key.escape && !store.processing && !store.confirmRequest) { exit(); return; }
    if (!store.confirmRequest) return;
    if (input === 'y' || input === 's') store.resolveConfirm('s');
    else if (input === 'n' || key.return) store.resolveConfirm('n');
  });

  const showInput   = !store.confirmRequest;
  const showConfirm = !!store.confirmRequest;

  const dynamicArea = [];

  if (store.spinner && !store.liveThinking) {
    dynamicArea.push(
      h(SpinnerLine, { key: 'spinner', label: store.spinner.label, started: store.spinner.started })
    );
  }

  if (store.liveThinking) {
    dynamicArea.push(
      h(ThinkingBlock, { key: 'thinking', text: store.liveThinking.text, live: true, width })
    );
  }

  if (store.liveAnswer) {
    dynamicArea.push(
      h(AnswerBlock, { key: 'answer', text: store.liveAnswer.text, live: true, width })
    );
  }

  if (showConfirm) {
    dynamicArea.push(
      h(ConfirmBar, { key: 'confirm', title: store.confirmRequest.title, detail: store.confirmRequest.detail })
    );
  }

  if (showInput) {
    dynamicArea.push(
      h(InputBar, { key: 'input', onSubmit: handleInput, processing: store.processing })
    );
  }

  return h(Box, { flexDirection: 'column', width: '100%', height: '100%' },
    h(Box, { flexDirection: 'column', flexGrow: 1, overflowY: 'hidden' },
      h(Static, { items: store.items }, (item) =>
        h(Box, { key: item.id, flexDirection: 'column' },
          h(StaticItem, { item, width }),
        ),
      ),
      ...dynamicArea,
    ),
    h(StatusBar, { model: modelLabel, processing: store.processing, width, turnCount: store.turnCount }),
  );
}

function getUiBindings(store, state) {
  return {
    beginThinkingStream:    () => store.beginThinking(),
    writeThinkingDelta:     (_st, delta) => store.appendThinking(delta),
    endThinkingStream:      () => store.endThinking(),
    beginAssistantStream:   () => store.beginAnswer(),
    writeAssistantDelta:    (_st, delta) => store.appendAnswer(delta),
    endAssistantStream:     () => store.endAnswer(),
    logEvent: (st, kind, title, detail) => {
      pushAction(st, kind, title, detail);
      store.addEvent(kind, title, detail || '');
    },
    startThinkingIndicator: (st, label) => {
      pushAction(st, 'think', label);
      store.setSpinner(label);
      return () => store.setSpinner(null);
    },
    pushAction: (st, kind, title, detail) => pushAction(st, kind, title, detail),
    paint: (text) => text,
  };
}

export async function startTUI(options = {}) {
  const { state, resumed } = await loadOrCreateSessionState(null, options);
  const store = new UIStore();

  state.rl = null;
  state.tuiConfirm = (title, detail) => store.requestConfirm(title, detail);
  state.getQueuedMessages = () => {
    const msgs = store.messageQueue.splice(0);
    if (msgs.length) store._emit();
    return msgs;
  };

  const modelKey   = state.activeModel || DEFAULT_MODEL_KEY;
  const modelLabel = (MODELS[modelKey]?.label || modelKey).toLowerCase();
  const cwd = state.cwd || process.cwd();

  store.addItem({ type: 'banner', model: modelLabel, resumed, cwd });

  const processInput = async (input) => {
    if (input === '/exit' || input === '/quit') {
      store.pendingExit = true;
      store.addEvent('info', 'hasta luego');
      return;
    }

    store.addItem({ type: 'divider' });
    store.addItem({ type: 'user', text: input });

    if (input.startsWith('/')) {
      const lines = [];
      const origLog   = console.log;
      const origError = console.error;
      console.log   = (...args) => lines.push(stripAnsi(args.join(' ')));
      console.error = (...args) => lines.push(stripAnsi(args.join(' ')));

      try {
        const printMod = require('../cli/print');
        const deps = {
          appendTranscriptEntry,
          applyLoadedState,
          printBanner:   printMod.printBanner,
          printHistory:  printMod.printHistory,
          printMemory:   printMod.printMemory,
          printSession:  printMod.printSession,
          printSessions: printMod.printSessions,
          printStatus:   printMod.printStatus,
        };
        const handled = await handleLocalCommand(input, state, deps);
        if (handled && lines.length > 0) {
          const clean = lines.filter(l => l.trim()).join('\n');
          if (clean) store.addItem({ type: 'system', text: clean });
        }
        if (!handled) store.addEvent('warn', 'comando no reconocido', input);
      } catch (err) {
        store.addEvent('error', 'error', err.message);
      } finally {
        console.log   = origLog;
        console.error = origError;
      }
      return;
    }

    const origError = console.error;
    console.error = () => {};

    try {
      const ui     = getUiBindings(store, state);
      const result = await runAgentTurn(input, state, ui);
      if (!result.rendered && result.content) {
        store.addItem({ type: 'answer', text: result.content });
      }
    } catch (err) {
      store.addEvent('error', 'error', err.message);
    } finally {
      console.error = origError;
    }
  };

  let appInstance = null;

  const handleSubmit = async (input) => {
    if (store.processing) {
      store.enqueueMessage(input);
      return;
    }

    store.processing = true;
    store.turnCount += 1;
    store._emit();

    await processInput(input);

    while (store.messageQueue.length > 0) {
      const next = store.messageQueue.shift();
      store.turnCount += 1;
      store._emit();
      await processInput(next);
    }

    store.processing = false;
    store._emit();

    if (store.pendingExit && appInstance) {
      appInstance.unmount();
    }
  };

  appInstance = render(h(App, { store, state, onSubmit: handleSubmit }), {
    exitOnCtrlC: false,
  });
  await appInstance.waitUntilExit();
}
