import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, Static, useInput, useApp, useStdout } from 'ink';
import { createRequire } from 'module';
import { EventEmitter } from 'events';

const require = createRequire(import.meta.url);
const { runAgentTurn } = require('../core/agent');
const { handleLocalCommand } = require('../cli/commands');
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
  THINK_FRAMES,
} = require('../config');

const h = React.createElement;
const MAX_THINKING_LINES = 20;
const SPIN_MS = 80;

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const T = {
  bg:          '#0d0d0d',
  surface:     '#141414',
  surfaceHi:   '#1a1a1a',
  text:        '#e0e0e0',
  textDim:     '#999999',
  textMuted:   '#666666',
  textGhost:   '#444444',
  textInvis:   '#2a2a2a',
  accent:      '#d4a054',
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
  cyan:        '#66bbbb',
  cyanDim:     '#336666',
  border:      '#222222',
  borderLight: '#333333',
};

const SEP = '─';
const VERT = '│';

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


function Divider({ width }) {
  const w = width || 60;
  return h(Box, { paddingLeft: 2 },
    h(Text, { color: T.textInvis }, SEP.repeat(w)),
  );
}

function Banner({ model, resumed, width }) {
  const w = width || 60;
  return h(Box, { flexDirection: 'column', paddingLeft: 2, paddingTop: 1, paddingBottom: 1 },
    h(Box, {},
      h(Text, { color: T.accent, bold: true }, ' ▌ '),
      h(Text, { color: T.text, bold: true }, APP_NAME),
      h(Text, { color: T.textMuted }, '  '),
      h(Text, { color: T.textMuted }, model),
    ),
    h(Box, {},
      h(Text, { color: T.textGhost }, '  ' + (resumed ? 'session resumed' : 'new session')),
      h(Text, { color: T.textInvis }, '   ' + SEP.repeat(Math.max(10, w - 30))),
    ),
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

  return h(Box, { paddingLeft: 2, gap: 2 },
    h(Text, { color: T.accent }, SPIN_FRAMES[frame]),
    h(Text, { color: T.textMuted }, label),
    elapsedStr ? h(Text, { color: T.textGhost }, ' ' + elapsedStr) : null,
  );
}

function EventLine({ kind, title, detail }) {
  const cfg = {
    info:    { sym: '·',  color: T.textGhost },
    think:   { sym: '◐',  color: T.textGhost },
    tool:    { sym: '⤳',  color: T.purple },
    ok:      { sym: '✓',  color: T.green },
    warn:    { sym: '▲',  color: T.amber },
    error:   { sym: '✕',  color: T.red },
  };
  const { sym, color } = cfg[kind] || cfg.info;

  return h(Box, { paddingLeft: 2, gap: 2 },
    h(Text, { color }, sym),
    h(Text, { color: kind === 'tool' ? T.textDim : T.textMuted }, title),
    detail ? h(Text, { color: T.textGhost }, ' ' + detail) : null,
  );
}

function UserMessage({ text, width }) {
  return h(Box, { paddingLeft: 2, marginTop: 1, gap: 1 },
    h(Text, { color: T.accent, bold: true }, '  ▌'),
    h(Text, { color: T.text, wrap: 'wrap' }, text),
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

  const pulseChar = live ? SPIN_FRAMES[Math.floor(Date.now() / SPIN_MS) % SPIN_FRAMES.length] : '◐';

  const label = live
    ? ` ${pulseChar}  thinking...`
    : ` ◐  thought ${elapsed}s`;

  return h(Box, { flexDirection: 'column', paddingLeft: 2, marginTop: 1 },
    h(Text, { color: T.textGhost }, label),
    lines.length > 0
      ? h(Box, { flexDirection: 'column', paddingLeft: 3, borderStyle: 'none' },
          ...lines.map((line, i) =>
            h(Text, { key: String(i), color: T.textInvis, wrap: 'wrap' }, line),
          ),
          more > 0 ? h(Text, { color: T.textGhost }, `   · · ·  ${more} more lines`) : null,
        )
      : null,
  );
}

function AnswerBlock({ text, live, width }) {
  if (!text) return null;
  const lines = text.split('\n');
  return h(Box, { flexDirection: 'column', paddingLeft: 3, marginTop: 1 },
    ...lines.map((line, i) =>
      h(Text, { key: String(i), color: T.text, wrap: 'wrap' }, line),
    ),
    live
      ? h(Text, { color: T.accent }, '▎')
      : null,
  );
}

function SystemMsg({ text }) {
  return h(Box, { flexDirection: 'column', paddingLeft: 2 },
    ...text.split('\n').map((line, i) =>
      h(Text, { key: String(i), color: T.textMuted, wrap: 'wrap' }, line),
    ),
  );
}

function ConfirmBar({ title, detail }) {
  const detailLines = (detail || '').split('\n').filter(l => l.trim()).slice(0, 8);

  return h(Box, { flexDirection: 'column', paddingLeft: 2, marginTop: 1 },
    h(Box, { gap: 2 },
      h(Text, { color: T.amber, bold: true }, '  ?'),
      h(Text, { color: T.text, bold: true }, title),
    ),
    detailLines.length > 0
      ? h(Box, { flexDirection: 'column', paddingLeft: 4 },
          ...detailLines.map((line, i) =>
            h(Text, { key: String(i), color: T.textDim, wrap: 'wrap' }, line),
          ),
        )
      : null,
    h(Box, { marginTop: 1, paddingLeft: 2, gap: 3 },
      h(Text, { color: T.green, bold: true }, ' y'),
      h(Text, { color: T.textGhost }, 'allow'),
      h(Text, { color: T.textInvis }, '·'),
      h(Text, { color: T.red, bold: true }, ' n'),
      h(Text, { color: T.textGhost }, 'deny'),
    ),
  );
}

function StatusIndicator({ processing }) {
  if (!processing) return null;

  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame(f => (f + 1) % SPIN_FRAMES.length), SPIN_MS);
    return () => clearInterval(t);
  }, []);

  return h(Box, {},
    h(Text, { color: T.accent }, SPIN_FRAMES[frame]),
  );
}

function StatusBar({ model, processing, width }) {
  const items = [
    h(Text, { key: 'name', color: T.accent, bold: true }, ` ${APP_NAME}`),
    h(Text, { key: 'sep1', color: T.textInvis }, ' ─ '),
    h(Text, { key: 'model', color: T.textMuted }, model),
  ];

  if (processing) {
    items.push(h(StatusIndicator, { key: 'status', processing }));
  }

  const spacerCount = Math.max(2, Math.floor((width - 40) / 2));

  const rightItems = [
    h(Text, { key: 'rsep', color: T.textInvis }, ' '.repeat(spacerCount)),
    h(Text, { key: 'esc', color: T.textGhost }, 'esc'),
    h(Text, { key: 'rsep2', color: T.textInvis }, ' to exit'),
  ];

  return h(Box, {
    paddingLeft: 1,
    paddingRight: 1,
    borderStyle: 'single',
    borderColor: T.borderLight,
  },
    ...items,
    ...rightItems,
  );
}

function StaticItem({ item, width }) {
  switch (item.type) {
    case 'banner':   return h(Banner,        { model: item.model, resumed: item.resumed, width });
    case 'divider':  return h(Divider,       { width });
    case 'user':     return h(UserMessage,   { text: item.text, width });
    case 'thinking': return h(ThinkingBlock, { text: item.text, elapsed: item.elapsed, width });
    case 'answer':   return h(AnswerBlock,   { text: item.text, width });
    case 'event':    return h(EventLine,     { kind: item.kind, title: item.title, detail: item.detail });
    case 'system':   return h(SystemMsg,     { text: item.text });
    default:         return null;
  }
}

function InputBar({ onSubmit, model }) {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (key.return) {
      if (value.trim()) {
        const text = value.trim();
        setValue('');
        onSubmit(text);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue(v => v.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue(v => v + input);
    }
  });

  const hasText = value.trim().length > 0;

  return h(Box, { flexDirection: 'column', paddingLeft: 1, paddingRight: 1 },
    h(Box, {},
      h(Text, { color: T.accent, bold: true }, ' > '),
      h(Text, { color: hasText ? T.text : T.textGhost }, value),
      h(Text, { color: T.accent }, hasText ? '' : '▎'),
    ),
  );
}


function App({ store, state, onSubmit }) {
  useStore(store);
  const { exit } = useApp();
  const { width, height } = useDimensions();

  const modelKey   = state?.activeModel || DEFAULT_MODEL_KEY;
  const modelLabel = (MODELS[modelKey]?.label || modelKey).toLowerCase();

  const handleInput = useCallback((text) => {
    if (text === '/exit' || text === '/quit') { exit(); return; }
    onSubmit(text);
  }, [onSubmit, exit]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return; }
    if (key.escape && !store.processing && !store.confirmRequest) { exit(); return; }
    if (!store.confirmRequest) return;
    if (input === 'y' || input === 's') store.resolveConfirm('s');
    else if (input === 'n' || key.return) store.resolveConfirm('n');
  });

  const showInput   = !store.processing && !store.confirmRequest;
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
      h(InputBar, { key: 'input', onSubmit: handleInput, model: modelLabel })
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
    h(StatusBar, { model: modelLabel, processing: store.processing, width }),
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

  const modelKey   = state.activeModel || DEFAULT_MODEL_KEY;
  const modelLabel = (MODELS[modelKey]?.label || modelKey).toLowerCase();

  store.addItem({ type: 'banner', model: modelLabel, resumed });

  const handleSubmit = async (input) => {
    store.processing = true;
    store._emit();

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

      store.processing = false;
      store._emit();
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

    store.processing = false;
    store._emit();
  };

  const app = render(h(App, { store, state, onSubmit: handleSubmit }), {
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
}
