const readline = require('readline/promises');

const { handleLocalCommand, printHelp } = require('./commands');
const {
  beginAssistantStream,
  beginThinkingStream,
  endAssistantStream,
  endThinkingStream,
  logEvent,
  paint,
  printBanner,
  printHistory,
  printMemory,
  printSession,
  printSessions,
  printStatus,
  printWelcome,
  pushAction,
  startThinkingIndicator,
  streamBufferedAssistantMessage,
  writeAssistantDelta,
  writeThinkingDelta,
} = require('./print');
const { runAgentTurn } = require('../core/agent');
const {
  applyLoadedState,
  loadOrCreateSessionState,
} = require('../utils/sessionStorage');
const { appendTranscriptEntry } = require('../utils/transcriptStorage');

async function readPromptFromStdin() {
  if (process.stdin.isTTY) {
    return '';
  }

  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data.trim();
}

function getUiBindings() {
  return {
    beginAssistantStream,
    beginThinkingStream,
    endAssistantStream,
    endThinkingStream,
    logEvent,
    paint,
    pushAction,
    startThinkingIndicator,
    writeAssistantDelta,
    writeThinkingDelta,
  };
}

function getCommandDeps() {
  return {
    appendTranscriptEntry,
    applyLoadedState,
    printBanner,
    printHistory,
    printMemory,
    printSession,
    printSessions,
    printStatus,
  };
}

async function runSinglePrompt(prompt, options = {}) {
  const rl = process.stdin.isTTY && process.stdout.isTTY
    ? readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })
    : null;
  let state = null;

  try {
    const loaded = await loadOrCreateSessionState(rl, options);
    state = loaded.state;
    const { resumed } = loaded;
    if (process.stdout.isTTY) {
      await printWelcome();
      printBanner(state);
      logEvent(state, 'info', resumed ? 'sesion retomada' : 'sesion nueva');
      console.log('');
    }

    const result = await runAgentTurn(prompt, state, getUiBindings());
    if (process.stdout.isTTY) {
      if (!result.rendered) {
        await streamBufferedAssistantMessage(state, result.content);
      }
    } else {
      process.stdout.write(`${result.content}\n`);
    }
  } finally {
    state?.rl?.close();
  }
}

async function runInteractiveChatClassic(options = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const { state, resumed } = await loadOrCreateSessionState(rl, options);
  await printWelcome();
  printBanner(state);
  logEvent(state, 'info', resumed ? 'sesion reanudada' : 'chat activo — /help para comandos');
  console.log('');

  try {
    while (true) {
      const input = (await rl.question('  \x1b[97m❯\x1b[0m ')).trim();
      if (!input) {
        continue;
      }

      if (input === '/exit' || input === '/quit') {
        logEvent(state, 'info', 'Hasta luego');
        break;
      }

      if (input.startsWith('/')) {
        try {
          const handled = await handleLocalCommand(input, state, getCommandDeps());
          if (handled) {
            continue;
          }
        } catch (err) {
          console.error(`Error: ${err.message}`);
          continue;
        }
      }

      try {
        const result = await runAgentTurn(input, state, getUiBindings());
        if (!result.rendered) {
          await streamBufferedAssistantMessage(state, result.content);
        }
      } catch (err) {
        logEvent(state, 'error', 'Error', err.message);
      }
    }
  } finally {
    rl.close();
  }
}

async function runInteractiveChat(options = {}) {
  let useTui = false;
  try {
    require.resolve('ink');
    useTui = true;
  } catch {}

  if (useTui) {
    const { startTUI } = await import('../tui/app.mjs');
    await startTUI(options);
  } else {
    await runInteractiveChatClassic(options);
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const options = {
    forceNew: false,
    sessionId: null,
  };
  const args = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--new') {
      options.forceNew = true;
      continue;
    }

    if (arg === '--resume') {
      options.sessionId = rawArgs[index + 1] ?? null;
      index += 1;
      continue;
    }

    args.push(arg);
  }

  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    return;
  }

  const stdinPrompt = await readPromptFromStdin();
  if (stdinPrompt) {
    await runSinglePrompt(stdinPrompt, options);
    return;
  }

  if (args.length > 0) {
    await runSinglePrompt(args.join(' '), options);
    return;
  }

  await runInteractiveChat(options);
}

module.exports = {
  main,
};
