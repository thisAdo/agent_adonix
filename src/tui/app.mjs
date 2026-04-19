import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, Static, useInput, useApp } from 'ink';
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
const SPIN_MS = 100;

const SPIN_FRAMES = ['⠂', '⠐', '⠠', '⡀', '⢀', '⠄', '⠁', '⠈'];

const C = {
  bg:      undefined,
  coral:   '#cc785c',
  text:    '#e8e8e5',
  sub:     '#a8a8a3',
  muted:   '#686865',
  dim:     '#4a4a47',
  ghost:   '#3a3a38',
  border:  '#1e1e1c',
  green:   '#6aac6a',
  amber:   '#c49a3c',
  red:     '#c05c5c',
  purple:  '#9a7ec8',
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


function Banner({ model, resumed }) {
  return h(Box, { flexDirection: 'column', paddingLeft: 2, paddingTop: 1, paddingBottom: 1 },
    h(Box, { gap: 1 },
      h(Text, { color: C.coral, bold: true }, '✦'),
      h(Text, { color: C.coral, bold: true }, APP_NAME.toLowerCase()),
      h(Text, { color: C.ghost }, model),
    ),
    h(Box, { gap: 1 },
      h(Text, { color: C.ghost }, resumed ? 'sesión resumida' : 'nueva sesión'),
      h(Text, { color: C.border }, '·'),
      h(Text, { color: C.ghost }, '/help'),
    ),
  );
}

function Divider() {
  return h(Box, { paddingLeft: 2, marginTop: 1 },
    h(Text, { color: C.border }, '─'.repeat(48)),
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
    h(Text, { color: C.coral }, SPIN_FRAMES[frame]),
    h(Text, { color: C.muted }, label),
    elapsedStr ? h(Text, { color: C.ghost }, elapsedStr) : null,
  );
}

function EventLine({ kind, title, detail }) {
  const cfg = {
    info:  { sym: '·',  color: C.ghost },
    think: { sym: '○',  color: C.ghost },
    tool:  { sym: '⚡', color: C.purple },
    ok:    { sym: '✓',  color: C.green },
    warn:  { sym: '!',  color: C.amber },
    error: { sym: '✕',  color: C.red },
  };
  const { sym, color } = cfg[kind] || cfg.info;

  return h(Box, { paddingLeft: 2, gap: 2 },
    h(Text, { color }, sym),
    h(Text, { color: C.muted }, title),
    detail ? h(Text, { color: C.ghost }, detail) : null,
  );
}

function UserMessage({ text }) {
  return h(Box, { paddingLeft: 2, marginTop: 1, gap: 1 },
    h(Text, { color: C.coral, bold: true }, '›'),
    h(Text, { color: C.text, wrap: 'wrap' }, text),
  );
}

function ThinkingBlock({ text, elapsed, live }) {
  const lines = text.split('\n').filter(l => l.trim()).slice(0, MAX_THINKING_LINES);
  const total  = text.split('\n').filter(l => l.trim()).length;
  const more   = total - MAX_THINKING_LINES;

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick(n => n + 1), 200);
    return () => clearInterval(t);
  }, [live]);

  const label = live ? 'pensando…' : `pensó  ${elapsed}s`;

  return h(Box, { flexDirection: 'column', paddingLeft: 2, marginTop: 1 },
    h(Text, { color: C.ghost }, `○  ${label}`),
    lines.length > 0
      ? h(Box, { flexDirection: 'column', paddingLeft: 3 },
          ...lines.map((line, i) =>
            h(Text, { key: String(i), color: C.dim, wrap: 'wrap' }, line),
          ),
          more > 0 ? h(Text, { color: C.ghost }, `· · ·  ${more} más`) : null,
        )
      : null,
  );
}

function AnswerBlock({ text, live }) {
  if (!text) return null;
  return h(Box, { flexDirection: 'column', paddingLeft: 3, marginTop: 1 },
    h(Text, { color: C.text, wrap: 'wrap' }, text),
    live ? h(Text, { color: C.coral }, '▎') : null,
  );
}

function SystemMsg({ text }) {
  return h(Box, { paddingLeft: 2 },
    h(Text, { color: C.muted, wrap: 'wrap' }, text),
  );
}

function ConfirmBar({ title, detail }) {
  const detailLines = (detail || '').split('\n').filter(l => l.trim()).slice(0, 8);

  return h(Box, { flexDirection: 'column', paddingLeft: 2, marginTop: 1 },
    h(Box, { gap: 1 },
      h(Text, { color: C.amber }, '!'),
      h(Text, { color: C.text, bold: true }, title),
    ),
    detailLines.length > 0
      ? h(Box, { flexDirection: 'column', paddingLeft: 2 },
          ...detailLines.map((line, i) =>
            h(Text, { key: String(i), color: C.sub, wrap: 'wrap' }, line),
          ),
        )
      : null,
    h(Box, { marginTop: 1, gap: 2 },
      h(Text, { color: C.green, bold: true }, 's'),
      h(Text, { color: C.ghost }, 'aceptar'),
      h(Text, { color: C.ghost }, '·'),
      h(Text, { color: C.red, bold: true }, 'n'),
      h(Text, { color: C.ghost }, 'rechazar'),
    ),
  );
}

function StaticItem({ item }) {
  switch (item.type) {
    case 'banner':   return h(Banner,        { model: item.model, resumed: item.resumed });
    case 'divider':  return h(Divider,       {});
    case 'user':     return h(UserMessage,   { text: item.text });
    case 'thinking': return h(ThinkingBlock, { text: item.text, elapsed: item.elapsed });
    case 'answer':   return h(AnswerBlock,   { text: item.text });
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

  return h(Box, { flexDirection: 'column', paddingLeft: 2, marginTop: 1, paddingBottom: 1 },
    h(Box, { gap: 1 },
      h(Text, { color: C.coral, bold: true }, '›'),
      h(Text, { color: C.text }, value || ''),
      h(Text, { color: C.coral }, '▎'),
    ),
    h(Box, { gap: 1 },
      h(Text, { color: C.ghost }, model),
      h(Text, { color: C.border }, '·'),
      h(Text, { color: C.ghost }, '/help'),
      h(Text, { color: C.border }, '·'),
      h(Text, { color: C.ghost }, 'esc'),
    ),
  );
}


function App({ store, state, onSubmit }) {
  useStore(store);
  const { exit } = useApp();

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
    if (input === 's' || input === 'y') store.resolveConfirm('s');
    else if (input === 'n' || key.return) store.resolveConfirm('n');
  });

  const showInput   = !store.processing && !store.confirmRequest;
  const showConfirm = !!store.confirmRequest;

  return h(Box, { flexDirection: 'column' },
    h(Static, { items: store.items }, (item) =>
      h(Box, { key: item.id, flexDirection: 'column' },
        h(StaticItem, { item }),
      ),
    ),

    store.spinner && !store.liveThinking
      ? h(SpinnerLine, { label: store.spinner.label, started: store.spinner.started })
      : null,

    store.liveThinking
      ? h(ThinkingBlock, { text: store.liveThinking.text, live: true })
      : null,

    store.liveAnswer
      ? h(AnswerBlock, { text: store.liveAnswer.text, live: true })
      : null,

    showConfirm
      ? h(ConfirmBar, { title: store.confirmRequest.title, detail: store.confirmRequest.detail })
      : null,

    showInput
      ? h(InputBar, { onSubmit: handleInput, model: modelLabel })
      : null,
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

  const app = render(h(App, { store, state, onSubmit: handleSubmit }));
  await app.waitUntilExit();
}
