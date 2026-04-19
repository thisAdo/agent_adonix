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
const MAX_THINKING_DISPLAY = 20;

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
    this._idCounter = 0;
    this._scheduled = false;
  }

  addItem(item) {
    this._idCounter += 1;
    this.items = [...this.items, { ...item, id: String(this._idCounter) }];
    this._emit();
  }

  setSpinner(label) {
    this.spinner = label ? { label } : null;
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

function useStore(store) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const handler = () => setTick(t => t + 1);
    store.on('update', handler);
    return () => store.off('update', handler);
  }, [store]);
}

function Header({ state }) {
  const key = state?.activeModel || DEFAULT_MODEL_KEY;
  const model = (MODELS[key]?.label || key).toLowerCase();

  return h(Box, { flexDirection: 'column', paddingLeft: 2, marginBottom: 1 },
    h(Box, null,
      h(Text, { bold: true, color: 'white' }, '\u25C6 ' + APP_NAME + '  '),
      h(Text, { color: 'gray' }, '\u00B7 '),
      h(Text, { color: 'gray', dimColor: true }, model),
    ),
    h(Text, { color: 'gray', dimColor: true }, '/help para comandos'),
  );
}

function SpinnerLine({ label }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setFrame(f => (f + 1) % THINK_FRAMES.length),
      80,
    );
    return () => clearInterval(timer);
  }, []);

  return h(Box, { paddingLeft: 2 },
    h(Text, { color: 'gray' }, THINK_FRAMES[frame] + ' '),
    h(Text, { color: 'gray', dimColor: true }, label),
  );
}

function EventLine({ kind, title, detail }) {
  const symbols = {
    info: '\u00B7', think: '\u25CB', tool: '\u25B8',
    ok: '\u2713', warn: '!', error: '\u2717',
  };
  const colors = {
    ok: 'green', error: 'red', warn: 'yellow',
  };
  const sym = symbols[kind] || '\u00B7';
  const symColor = colors[kind] || 'gray';

  return h(Box, { paddingLeft: 2 },
    h(Text, { color: symColor }, sym + ' '),
    h(Text, { color: 'white' }, title),
    detail
      ? h(Text, { color: 'gray', dimColor: true }, '  ' + detail)
      : null,
  );
}

function UserMessage({ text }) {
  return h(Box, { paddingLeft: 2, marginTop: 1 },
    h(Text, { bold: true, color: 'cyan' }, '\u276F '),
    h(Text, { color: 'white', wrap: 'wrap' }, text),
  );
}

function ThinkingBlock({ text, elapsed, live }) {
  const lines = text
    .split('\n')
    .filter(l => l.trim())
    .slice(0, MAX_THINKING_DISPLAY);
  const truncated = text.split('\n').filter(l => l.trim()).length > MAX_THINKING_DISPLAY;

  return h(Box, { flexDirection: 'column', paddingLeft: 2 },
    h(Text, { color: 'gray', dimColor: true, italic: true },
      live ? '\u250C pensando...' : '\u250C pens\u00F3',
    ),
    ...lines.map((line, i) =>
      h(Text, {
        key: String(i),
        color: 'gray',
        dimColor: true,
        wrap: 'wrap',
      }, '\u2502 ' + line),
    ),
    truncated
      ? h(Text, { color: 'gray', dimColor: true }, '\u2502 ...')
      : null,
    live
      ? null
      : h(Text, { color: 'gray', dimColor: true }, '\u2514 ' + elapsed + 's'),
  );
}

function AnswerBlock({ text, live }) {
  if (!text) return null;

  return h(Box, { flexDirection: 'column', paddingLeft: 2, marginTop: 1 },
    h(Text, { color: 'white', wrap: 'wrap' },
      h(Text, { bold: true }, '\u25C6 '),
      text,
    ),
    live
      ? h(Text, { color: 'gray', dimColor: true }, '  \u2588')
      : null,
  );
}

function SystemMessage({ text }) {
  return h(Box, { paddingLeft: 2 },
    h(Text, { color: 'gray', wrap: 'wrap' }, text),
  );
}

function ConfirmBar({ title, detail }) {
  const detailLines = (detail || '')
    .split('\n')
    .filter(l => l.trim())
    .slice(0, 6);

  return h(Box, { flexDirection: 'column', paddingLeft: 2, marginTop: 1 },
    h(Box, null,
      h(Text, { color: 'yellow' }, '? '),
      h(Text, { color: 'white', bold: true }, title),
    ),
    ...detailLines.map((line, i) =>
      h(Text, {
        key: String(i),
        color: 'gray',
        dimColor: true,
        wrap: 'wrap',
      }, '    ' + line),
    ),
    h(Box, { marginTop: 0 },
      h(Text, { color: 'yellow' }, '  s'),
      h(Text, { color: 'gray' }, '/'),
      h(Text, { color: 'yellow' }, 'N'),
      h(Text, { color: 'gray' }, ' \u276F '),
    ),
  );
}

function StaticItem({ item }) {
  switch (item.type) {
    case 'user':
      return h(UserMessage, { text: item.text });
    case 'thinking':
      return h(ThinkingBlock, { text: item.text, elapsed: item.elapsed });
    case 'answer':
      return h(AnswerBlock, { text: item.text });
    case 'event':
      return h(EventLine, {
        kind: item.kind,
        title: item.title,
        detail: item.detail,
      });
    case 'system':
      return h(SystemMessage, { text: item.text });
    default:
      return null;
  }
}

function InputBar({ onSubmit }) {
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

  return h(Box, { paddingLeft: 2, marginTop: 1 },
    h(Text, { bold: true, color: 'cyan' }, '\u276F '),
    h(Text, { color: 'white' }, value),
    h(Text, { color: 'gray', dimColor: true }, '\u2588'),
  );
}

function App({ store, state, onSubmit }) {
  useStore(store);
  const { exit } = useApp();

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
    h(Header, { state }),

    h(Static, { items: store.items }, (item) =>
      h(Box, { key: item.id, flexDirection: 'column' },
        h(StaticItem, { item }),
      ),
    ),

    store.spinner && !store.liveThinking
      ? h(SpinnerLine, { label: store.spinner.label })
      : null,

    store.liveThinking
      ? h(ThinkingBlock, {
        text: store.liveThinking.text,
        live: true,
      })
      : null,

    store.liveAnswer
      ? h(AnswerBlock, {
        text: store.liveAnswer.text,
        live: true,
      })
      : null,

    showConfirm
      ? h(ConfirmBar, {
        title: store.confirmRequest.title,
        detail: store.confirmRequest.detail,
      })
      : null,

    showInput
      ? h(InputBar, { onSubmit: handleInput })
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

  store.addEvent('info', resumed ? 'sesion reanudada' : 'chat activo');

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
