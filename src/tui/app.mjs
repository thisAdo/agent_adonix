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
const MAX_THINKING_LINES = 24;
const SPIN_MS = 80;

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
    this.liveThinking = {
      ...this.liveThinking,
      text: this.liveThinking.text + delta,
    };
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
    this.liveAnswer = {
      ...this.liveAnswer,
      text: this.liveAnswer.text + delta,
    };
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
  return h(Box, { flexDirection: 'column', paddingLeft: 1 },
    h(Box, null,
      h(Text, { bold: true, inverse: true }, ' \u25C9 ' + APP_NAME.toLowerCase() + ' '),
      h(Text, null, ' '),
      h(Text, { dimColor: true }, model),
    ),
    h(Box, { paddingLeft: 2 },
      h(Text, { dimColor: true, italic: true },
        (resumed ? 'sesi\u00F3n reanudada' : 'nueva sesi\u00F3n')
        + '  \u00B7  /help para comandos'),
    ),
    h(Box, { paddingLeft: 1, marginTop: 0 },
      h(Text, { dimColor: true }, '\u2500'.repeat(48)),
    ),
  );
}

function SpinnerLine({ label, started }) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % THINK_FRAMES.length);
      if (started) setElapsed(Date.now() - started);
    }, SPIN_MS);
    return () => clearInterval(timer);
  }, [started]);

  const elapsedStr = elapsed > 1000 ? '  ' + formatElapsed(elapsed) : '';

  return h(Box, { paddingLeft: 2 },
    h(Text, { color: 'cyan' }, THINK_FRAMES[frame] + ' '),
    h(Text, { dimColor: true, italic: true }, label),
    elapsedStr ? h(Text, { dimColor: true }, elapsedStr) : null,
  );
}

function EventLine({ kind, title, detail }) {
  const icons = {
    info: { sym: '\u25CB', color: 'gray' },
    think: { sym: '\u25CE', color: 'gray' },
    tool: { sym: '\u25CF', color: 'magenta' },
    ok: { sym: '\u2713', color: 'green' },
    warn: { sym: '\u26A0', color: 'yellow' },
    error: { sym: '\u2717', color: 'red' },
  };
  const { sym, color } = icons[kind] || icons.info;

  return h(Box, { paddingLeft: 2 },
    h(Text, { color }, sym + ' '),
    h(Text, { color: 'white' }, title),
    detail ? h(Text, { dimColor: true }, '  ' + detail) : null,
  );
}

function UserMessage({ text }) {
  return h(Box, { paddingLeft: 2, marginTop: 1 },
    h(Text, { bold: true, color: 'cyan' }, '\u276F '),
    h(Text, { color: 'white', bold: true, wrap: 'wrap' }, text),
  );
}

function ThinkingBlock({ text, elapsed, live }) {
  const lines = text
    .split('\n')
    .filter(l => l.trim())
    .slice(0, MAX_THINKING_LINES);
  const total = text.split('\n').filter(l => l.trim()).length;
  const truncated = total > MAX_THINKING_LINES;

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setTick(t => t + 1), 200);
    return () => clearInterval(timer);
  }, [live]);

  const label = live
    ? '\u25CE pensando\u2026'
    : '\u25CE pens\u00F3  ' + elapsed + 's';

  return h(Box, { flexDirection: 'column', paddingLeft: 2, marginTop: 0 },
    h(Text, { dimColor: true, italic: true }, label),
    lines.length > 0
      ? h(Box, { flexDirection: 'column', paddingLeft: 3 },
        ...lines.map((line, i) =>
          h(Text, { key: String(i), dimColor: true, wrap: 'wrap' }, line),
        ),
        truncated
          ? h(Text, { dimColor: true, italic: true },
            '(' + (total - MAX_THINKING_LINES) + ' l\u00EDneas m\u00E1s)')
          : null,
      )
      : null,
  );
}

function AnswerBlock({ text, live }) {
  if (!text) return null;
  return h(Box, { flexDirection: 'column', paddingLeft: 2, marginTop: 1 },
    h(Text, { color: 'white', wrap: 'wrap' }, text),
    live ? h(Text, { dimColor: true }, '\u2588') : null,
  );
}

function SystemMsg({ text }) {
  return h(Box, { paddingLeft: 2 },
    h(Text, { dimColor: true, wrap: 'wrap' }, text),
  );
}

function ConfirmBar({ title, detail }) {
  const detailLines = (detail || '')
    .split('\n')
    .filter(l => l.trim())
    .slice(0, 8);

  return h(Box, { flexDirection: 'column', paddingLeft: 2, marginTop: 1 },
    h(Box, null,
      h(Text, { dimColor: true }, '\u2500'.repeat(40)),
    ),
    h(Box, { marginTop: 0 },
      h(Text, { color: 'yellow', bold: true }, '\u26A0 '),
      h(Text, { color: 'white', bold: true }, title),
    ),
    detailLines.length > 0
      ? h(Box, { flexDirection: 'column', paddingLeft: 3 },
        ...detailLines.map((line, i) =>
          h(Text, { key: String(i), dimColor: true, wrap: 'wrap' }, line),
        ),
      )
      : null,
    h(Box, { marginTop: 1 },
      h(Text, { dimColor: true }, '  '),
      h(Text, { color: 'green', bold: true }, 's'),
      h(Text, { dimColor: true }, ' aceptar  '),
      h(Text, { color: 'red', bold: true }, 'n'),
      h(Text, { dimColor: true }, ' rechazar'),
    ),
  );
}

function StaticItem({ item }) {
  switch (item.type) {
    case 'banner':
      return h(Banner, { model: item.model, resumed: item.resumed });
    case 'user':
      return h(UserMessage, { text: item.text });
    case 'thinking':
      return h(ThinkingBlock, { text: item.text, elapsed: item.elapsed });
    case 'answer':
      return h(AnswerBlock, { text: item.text });
    case 'event':
      return h(EventLine, { kind: item.kind, title: item.title, detail: item.detail });
    case 'system':
      return h(SystemMsg, { text: item.text });
    default:
      return null;
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

  return h(Box, { flexDirection: 'column' },
    h(Box, { paddingLeft: 2, marginTop: 1 },
      h(Text, { bold: true, color: 'cyan' }, '\u276F '),
      h(Text, { color: 'white' }, value),
      h(Text, { dimColor: true }, '\u2588'),
    ),
    h(Box, { paddingLeft: 4 },
      h(Text, { dimColor: true },
        model + '  \u00B7  /help  \u00B7  esc salir'),
    ),
  );
}

function App({ store, state, onSubmit }) {
  useStore(store);
  const { exit } = useApp();

  const modelKey = state?.activeModel || DEFAULT_MODEL_KEY;
  const modelLabel = (MODELS[modelKey]?.label || modelKey).toLowerCase();

  const handleInput = useCallback((text) => {
    if (text === '/exit' || text === '/quit') {
      exit();
      return;
    }
    onSubmit(text);
  }, [onSubmit, exit]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (key.escape && !store.processing && !store.confirmRequest) {
      exit();
      return;
    }
    if (!store.confirmRequest) return;
    if (input === 's' || input === 'y') {
      store.resolveConfirm('s');
    } else if (input === 'n' || key.return) {
      store.resolveConfirm('n');
    }
  });

  const showInput = !store.processing && !store.confirmRequest;
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
      ? h(ConfirmBar, {
        title: store.confirmRequest.title,
        detail: store.confirmRequest.detail,
      })
      : null,

    showInput
      ? h(InputBar, { onSubmit: handleInput, model: modelLabel })
      : null,
  );
}

function getUiBindings(store, state) {
  return {
    beginThinkingStream: () => store.beginThinking(),
    writeThinkingDelta: (_st, delta) => store.appendThinking(delta),
    endThinkingStream: () => store.endThinking(),
    beginAssistantStream: () => store.beginAnswer(),
    writeAssistantDelta: (_st, delta) => store.appendAnswer(delta),
    endAssistantStream: () => store.endAnswer(),
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

  const modelKey = state.activeModel || DEFAULT_MODEL_KEY;
  const modelLabel = (MODELS[modelKey]?.label || modelKey).toLowerCase();
  store.addItem({ type: 'banner', model: modelLabel, resumed });

  const handleSubmit = async (input) => {
    store.processing = true;
    store._emit();

    store.addItem({ type: 'user', text: input });

    if (input.startsWith('/')) {
      const lines = [];
      const origLog = console.log;
      const origError = console.error;
      console.log = (...args) => lines.push(stripAnsi(args.join(' ')));
      console.error = (...args) => lines.push(stripAnsi(args.join(' ')));

      try {
        const printMod = require('../cli/print');
        const deps = {
          appendTranscriptEntry,
          applyLoadedState,
          printBanner: printMod.printBanner,
          printHistory: printMod.printHistory,
          printMemory: printMod.printMemory,
          printSession: printMod.printSession,
          printSessions: printMod.printSessions,
          printStatus: printMod.printStatus,
        };

        const handled = await handleLocalCommand(input, state, deps);
        if (handled && lines.length > 0) {
          const clean = lines.filter(l => l.trim()).join('\n');
          if (clean) store.addItem({ type: 'system', text: clean });
        }
        if (!handled) {
          store.addEvent('warn', 'Comando no reconocido', input);
        }
      } catch (err) {
        store.addEvent('error', 'Error', err.message);
      } finally {
        console.log = origLog;
        console.error = origError;
      }

      store.processing = false;
      store._emit();
      return;
    }

    const origError = console.error;
    console.error = () => {};

    try {
      const ui = getUiBindings(store, state);
      const result = await runAgentTurn(input, state, ui);

      if (!result.rendered && result.content) {
        store.addItem({ type: 'answer', text: result.content });
      }
    } catch (err) {
      store.addEvent('error', 'Error', err.message);
    } finally {
      console.error = origError;
    }

    store.processing = false;
    store._emit();
  };

  const app = render(
    h(App, { store, state, onSubmit: handleSubmit }),
  );

  await app.waitUntilExit();
}
