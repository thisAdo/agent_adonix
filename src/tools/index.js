const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const fsp = fs.promises;

const {
  MAX_FILE_LINES,
} = require('../config');
const { resolveInputPath } = require('../utils/pathUtils');
const {
  formatLineRange,
  shortText,
  truncateText,
} = require('../utils/text');

const TOOL_DEFINITIONS = [
  { name: 'list_dir', usage: '{ path? }' },
  { name: 'read_file', usage: '{ path, startLine?, endLine? }' },
  { name: 'search_text', usage: '{ pattern, path?, glob? }' },
  { name: 'glob_files', usage: '{ pattern, path? }' },
  { name: 'file_info', usage: '{ path }' },
  { name: 'run_command', usage: '{ command }' },
  { name: 'make_dir', usage: '{ path }' },
  { name: 'write_file', usage: '{ path, content }' },
  { name: 'append_file', usage: '{ path, content }' },
  { name: 'replace_in_file', usage: '{ path, search, replace, all? }' },
  { name: 'fetch_url', usage: '{ url, selector?, attribute?, limit?, headers? }' },
];

function getToolPromptText() {
  return [
    'Herramientas disponibles:',
    ...TOOL_DEFINITIONS.map(tool => `- ${tool.name} ${tool.usage}`),
    '',
    'Guia de uso:',
    '- fetch_url sin selector: devuelve el HTML completo de la pagina.',
    '- fetch_url con selector: extrae texto de elementos CSS (ej: "h1", ".title", "#content p").',
    '- fetch_url con selector + attribute: extrae un atributo especifico (ej: "href", "src").',
    '- Para scraping: primero fetch_url sin selector para ver la estructura, luego con selector para extraer.',
    '- Para recursos del sistema: usa run_command con top, free, df, etc.',
  ].join('\n');
}

function printTools() {
  console.log('Herramientas disponibles:');
  for (const tool of TOOL_DEFINITIONS) {
    console.log(`  ${tool.name} ${tool.usage}`);
  }
}

function describeToolCall(call) {
  switch (call.tool) {
    case 'list_dir':
      return `Listando ${call.args.path ?? '.'}`;
    case 'read_file':
      return `Leyendo ${call.args.path}`;
    case 'search_text':
      return `Buscando "${shortText(call.args.pattern, 40)}" en ${call.args.path ?? '.'}`;
    case 'glob_files':
      return `Patron ${shortText(call.args.pattern, 50)} en ${call.args.path ?? '.'}`;
    case 'file_info':
      return `Inspeccionando ${call.args.path}`;
    case 'run_command':
      return `Comando ${shortText(call.args.command, 70)}`;
    case 'make_dir':
      return `Creando carpeta ${call.args.path}`;
    case 'write_file':
      return `Escribiendo ${call.args.path}`;
    case 'append_file':
      return `Anexando ${call.args.path}`;
    case 'replace_in_file':
      return `Editando ${call.args.path}`;
    case 'fetch_url': {
      const cleanedUrl = cleanUrl(call.args.url || '');
      const sel = call.args.selector ? ` → ${shortText(call.args.selector, 30)}` : '';
      return `Fetch ${shortText(cleanedUrl, 50)}${sel}`;
    }
    default:
      return call.tool;
  }
}

function globToRegExp(pattern) {
  let source = pattern.replace(/\\/g, '/');
  source = source.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  source = source.replace(/\\\*\\\*/g, '::DOUBLE_STAR::');
  source = source.replace(/\\\*/g, '[^/]*');
  source = source.replace(/\\\?/g, '[^/]');
  source = source.replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${source}$`);
}

async function walkEntries(rootPath, limit = 5000) {
  const results = [];
  const queue = [rootPath];

  while (queue.length > 0 && results.length < limit) {
    const currentPath = queue.shift();
    const entries = await fsp.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, '/');
      results.push({
        absolutePath,
        relativePath,
        dirent: entry,
      });

      if (entry.isDirectory() && results.length < limit) {
        queue.push(absolutePath);
      }
    }
  }

  return results;
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, options.timeoutMs)
      : null;

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', code => {
      if (timer) {
        clearTimeout(timer);
      }

      resolve({
        code,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

async function askConfirmation(rl, title, detail, paint, state) {
  if (state?.autoApprove) {
    if (!state?.tuiConfirm) {
      console.error(`  ${paint('\u21AA', 'green')} ${paint(title, 'dim')}`);
    }
    return true;
  }

  if (state?.tuiConfirm) {
    const answer = await state.tuiConfirm(title, detail || '');
    return answer === 's' || answer === 'si' || answer === 'y' || answer === 'yes';
  }

  if (!rl) {
    return false;
  }

  console.error('');
  console.error(`  ${paint('?', 'yellow')} ${title}`);
  if (detail) {
    for (const line of detail.split('\n')) {
      if (line.trim()) console.error(`    ${paint(line, 'dim')}`);
    }
  }
  console.error('');

  const answer = (await rl.question(`  ${paint('s/N', 'yellow')} ${paint('\u276F', 'yellow')} `))
    .trim()
    .toLowerCase();
  return answer === 's' || answer === 'si' || answer === 'y' || answer === 'yes';
}

async function listDirTool(args, state) {
  const targetPath = resolveInputPath(args.path ?? '.', state.cwd);
  const entries = await fsp.readdir(targetPath, { withFileTypes: true });

  const formatted = entries
    .sort((left, right) => {
      if (left.isDirectory() && !right.isDirectory()) {
        return -1;
      }
      if (!left.isDirectory() && right.isDirectory()) {
        return 1;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, 250)
    .map(entry => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`)
    .join('\n');

  return `Ruta: ${targetPath}\n${formatted || '[vacio]'}`;
}

async function readFileTool(args, state) {
  const targetPath = resolveInputPath(args.path, state.cwd);
  const content = await fsp.readFile(targetPath, 'utf8');
  const lines = content.split('\n');
  const startLine = Math.max(Number(args.startLine ?? 1), 1);
  const endLimit = Math.min(lines.length, startLine + MAX_FILE_LINES - 1);
  const endLine = Math.min(Number(args.endLine ?? endLimit), endLimit);
  const body = formatLineRange(lines, startLine, endLine);

  return truncateText(
    `Archivo: ${targetPath}\nLineas ${startLine}-${endLine} de ${lines.length}\n\n${body}`,
  );
}

async function searchTextTool(args, state) {
  if (!args.pattern || typeof args.pattern !== 'string') {
    throw new Error('search_text requiere pattern');
  }

  const targetPath = resolveInputPath(args.path ?? '.', state.cwd);
  const rgArgs = ['--line-number', '--no-heading', '--color', 'never'];

  if (args.glob && typeof args.glob === 'string') {
    rgArgs.push('--glob', args.glob);
  }

  rgArgs.push(args.pattern, targetPath);

  const result = await runProcess('rg', rgArgs, {
    cwd: state.cwd,
    timeoutMs: 20000,
  });

  if (result.code === 1) {
    return `Sin coincidencias en ${targetPath}`;
  }

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `rg fallo con codigo ${result.code}`);
  }

  return truncateText(result.stdout.trim() || `Sin coincidencias en ${targetPath}`);
}

async function globFilesTool(args, state) {
  if (!args.pattern || typeof args.pattern !== 'string') {
    throw new Error('glob_files requiere pattern');
  }

  const targetPath = resolveInputPath(args.path ?? '.', state.cwd);
  const regex = globToRegExp(args.pattern);
  const entries = await walkEntries(targetPath);
  const matches = entries
    .map(entry => entry.relativePath)
    .filter(relativePath => regex.test(relativePath))
    .slice(0, 300);

  return matches.length > 0
    ? `Base: ${targetPath}\n${matches.join('\n')}`
    : `Sin coincidencias para ${args.pattern} en ${targetPath}`;
}

async function fileInfoTool(args, state) {
  if (!args.path || typeof args.path !== 'string') {
    throw new Error('file_info requiere path');
  }

  const targetPath = resolveInputPath(args.path, state.cwd);
  const stats = await fsp.stat(targetPath);
  return [
    `Ruta: ${targetPath}`,
    `Tipo: ${stats.isDirectory() ? 'directorio' : 'archivo'}`,
    `Tamano: ${stats.size} bytes`,
    `Creado: ${stats.birthtime.toISOString()}`,
    `Modificado: ${stats.mtime.toISOString()}`,
  ].join('\n');
}

async function runCommandTool(args, state, paint) {
  if (!args.command || typeof args.command !== 'string') {
    throw new Error('run_command requiere command');
  }

  const command = cleanCommand(args.command);

  const allowed = await askConfirmation(
    state.rl,
    'Ejecutar comando',
    `${command}\n\nDirectorio: ${state.cwd}`,
    paint,
    state,
  );

  if (!allowed) {
    return 'Comando cancelado por el usuario.';
  }

  const result = await runProcess('bash', ['-lc', command], {
    cwd: state.cwd,
    timeoutMs: 120000,
  });

  const parts = [`Exit code: ${result.code ?? 'desconocido'}`];

  if (result.timedOut) {
    parts.push('Timeout: el comando fue detenido por tiempo.');
  }

  if (result.stdout.trim()) {
    parts.push(`STDOUT:\n${result.stdout.trim()}`);
  }

  if (result.stderr.trim()) {
    parts.push(`STDERR:\n${result.stderr.trim()}`);
  }

  return truncateText(parts.join('\n\n'));
}

async function makeDirTool(args, state, paint) {
  if (!args.path || typeof args.path !== 'string') {
    throw new Error('make_dir requiere path');
  }

  const targetPath = resolveInputPath(args.path, state.cwd);
  const allowed = await askConfirmation(
    state.rl,
    'Crear carpeta',
    targetPath,
    paint,
    state,
  );

  if (!allowed) {
    return 'Creacion cancelada por el usuario.';
  }

  await fsp.mkdir(targetPath, { recursive: true });
  return `Carpeta lista: ${targetPath}`;
}

async function writeFileTool(args, state, paint) {
  if (!args.path || typeof args.path !== 'string') {
    throw new Error('write_file requiere path');
  }

  if (typeof args.content !== 'string') {
    throw new Error('write_file requiere content');
  }

  const targetPath = resolveInputPath(args.path, state.cwd);
  const exists = fs.existsSync(targetPath);
  const preview = truncateText(args.content, 600);
  const allowed = await askConfirmation(
    state.rl,
    exists ? 'Sobrescribir archivo' : 'Crear archivo',
    `${targetPath}\n\nContenido propuesto:\n${preview}`,
    paint,
    state,
  );

  if (!allowed) {
    return 'Edicion cancelada por el usuario.';
  }

  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, args.content, 'utf8');
  return `${exists ? 'Archivo actualizado' : 'Archivo creado'}: ${targetPath}`;
}

async function appendFileTool(args, state, paint) {
  if (!args.path || typeof args.path !== 'string') {
    throw new Error('append_file requiere path');
  }

  if (typeof args.content !== 'string') {
    throw new Error('append_file requiere content');
  }

  const targetPath = resolveInputPath(args.path, state.cwd);
  const preview = truncateText(args.content, 600);
  const allowed = await askConfirmation(
    state.rl,
    'Anexar archivo',
    `${targetPath}\n\nBloque a agregar:\n${preview}`,
    paint,
    state,
  );

  if (!allowed) {
    return 'Edicion cancelada por el usuario.';
  }

  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.appendFile(targetPath, args.content, 'utf8');
  return `Contenido anexado: ${targetPath}`;
}

async function replaceInFileTool(args, state, paint) {
  if (!args.path || typeof args.path !== 'string') {
    throw new Error('replace_in_file requiere path');
  }

  if (typeof args.search !== 'string' || typeof args.replace !== 'string') {
    throw new Error('replace_in_file requiere search y replace');
  }

  const targetPath = resolveInputPath(args.path, state.cwd);
  const content = await fsp.readFile(targetPath, 'utf8');
  const matches = content.split(args.search).length - 1;

  if (matches === 0) {
    throw new Error('No encontre el texto a reemplazar');
  }

  const nextContent = args.all
    ? content.split(args.search).join(args.replace)
    : content.replace(args.search, args.replace);

  if (nextContent === content) {
    throw new Error('El reemplazo no produjo cambios');
  }

  const allowed = await askConfirmation(
    state.rl,
    'Editar archivo',
    [
      targetPath,
      '',
      `Coincidencias encontradas: ${matches}`,
      `Modo: ${args.all ? 'todas' : 'primera coincidencia'}`,
    ].join('\n'),
    paint,
    state,
  );

  if (!allowed) {
    return 'Edicion cancelada por el usuario.';
  }

  await fsp.writeFile(targetPath, nextContent, 'utf8');
  return `Archivo editado: ${targetPath}`;
}

function cleanUrl(raw) {
  let url = raw.trim();
  const mdLink = url.match(/\[([^\]]*)\]\(([^)]+)\)/);
  if (mdLink) {
    const text = mdLink[1].trim();
    const href = mdLink[2].trim();
    url = /^https?:\/\//.test(text) ? text : href;
  }
  url = url.replace(/^[`<"']+|[`>"']+$/g, '');
  return url;
}

function cleanCommand(raw) {
  let cmd = raw.trim();
  if (/^`[^`]+`$/.test(cmd)) {
    cmd = cmd.slice(1, -1).trim();
  }
  if (cmd.startsWith('```')) {
    cmd = cmd.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
  }
  cmd = cmd.replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (_, text, href) => {
    const trimText = text.trim();
    return /^https?:\/\//.test(trimText) ? trimText : href;
  });
  return cmd;
}

async function fetchUrlTool(args, state, paint) {
  if (!args.url || typeof args.url !== 'string') {
    throw new Error('fetch_url requiere url');
  }

  const url = cleanUrl(args.url);

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URL invalida: ${url}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Solo se permite http y https');
  }

  const detail = args.selector
    ? `GET ${url}\nSelector: ${args.selector}`
    : `GET ${url}`;

  const allowed = await askConfirmation(
    state.rl,
    'Fetch URL',
    detail,
    paint,
    state,
  );

  if (!allowed) {
    return 'Fetch cancelado por el usuario.';
  }

  const axios = require('axios');
  const response = await axios({
    url,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      ...(args.headers || {}),
    },
    timeout: 15000,
    maxContentLength: 512000,
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: () => true,
  });

  const body = typeof response.data === 'string'
    ? response.data
    : JSON.stringify(response.data, null, 2);

  const parts = [
    `Status: ${response.status}`,
    `Content-Type: ${response.headers['content-type'] || 'desconocido'}`,
  ];

  if (args.selector && typeof args.selector === 'string') {
    try {
      const cheerio = require('cheerio');
      const $ = cheerio.load(body);
      const elements = $(args.selector);
      const limit = Math.min(Number(args.limit) || 20, 50);
      const results = [];

      elements.each((i, el) => {
        if (i >= limit) return false;
        if (args.attribute && typeof args.attribute === 'string') {
          const val = $(el).attr(args.attribute);
          if (val) results.push(val);
        } else {
          const text = $(el).text().trim();
          if (text) results.push(text);
        }
      });

      parts.push(`Selector: ${args.selector}`);
      parts.push(`Coincidencias: ${elements.length} (mostrando ${results.length})`);
      parts.push('');
      parts.push(results.length > 0 ? results.join('\n') : '[sin coincidencias]');
    } catch (err) {
      parts.push(`Error en selector: ${err.message}`);
      parts.push('');
      parts.push(body);
    }
  } else {
    parts.push('');
    parts.push(body);
  }

  return truncateText(parts.join('\n'));
}

async function executeToolCall(call, state, ui) {
  ui.logEvent(state, 'tool', describeToolCall(call));

  let result;

  switch (call.tool) {
    case 'list_dir':
      result = await listDirTool(call.args, state);
      break;
    case 'read_file':
      result = await readFileTool(call.args, state);
      break;
    case 'search_text':
      result = await searchTextTool(call.args, state);
      break;
    case 'glob_files':
      result = await globFilesTool(call.args, state);
      break;
    case 'file_info':
      result = await fileInfoTool(call.args, state);
      break;
    case 'run_command':
      result = await runCommandTool(call.args, state, ui.paint);
      break;
    case 'make_dir':
      result = await makeDirTool(call.args, state, ui.paint);
      break;
    case 'write_file':
      result = await writeFileTool(call.args, state, ui.paint);
      break;
    case 'append_file':
      result = await appendFileTool(call.args, state, ui.paint);
      break;
    case 'replace_in_file':
      result = await replaceInFileTool(call.args, state, ui.paint);
      break;
    case 'fetch_url':
      result = await fetchUrlTool(call.args, state, ui.paint);
      break;
    default:
      throw new Error(`Herramienta no soportada: ${call.tool}`);
  }

  ui.logEvent(state, 'ok', 'Herramienta completada', shortText(result, 100));
  return result;
}

function parseDirectAction(input) {
  const text = input.trim();

  const runMatch = text.match(/^(?:ejecuta|corre)\s+(?:el\s+)?comando\s+([\s\S]+)$/i);
  if (runMatch) {
    return {
      tool: 'run_command',
      args: { command: runMatch[1].trim() },
    };
  }

  const mkdirMatch = text.match(/^(?:crea|crear|haz)\s+(?:la\s+)?(?:carpeta|directorio)\s+([^\s]+)$/i);
  if (mkdirMatch) {
    return {
      tool: 'make_dir',
      args: { path: mkdirMatch[1].trim() },
    };
  }

  const appendMatch = text.match(
    /^(?:anexa|agrega)\s+(?:al\s+)?archivo\s+([^\s]+)\s+el\s+contenido\s+([\s\S]+)$/i,
  );
  if (appendMatch) {
    return {
      tool: 'append_file',
      args: {
        path: appendMatch[1].trim(),
        content: appendMatch[2],
      },
    };
  }

  const writeMatch = text.match(
    /^(?:crea|crear)\s+(?:el\s+)?archivo\s+([^\s]+)\s+con\s+(?:el\s+)?contenido\s+([\s\S]+)$/i,
  );
  if (writeMatch) {
    return {
      tool: 'write_file',
      args: {
        path: writeMatch[1].trim(),
        content: writeMatch[2],
      },
    };
  }

  const replaceMatch = text.match(
    /^(?:reemplaza|cambia)\s+["']([\s\S]+?)["']\s+por\s+["']([\s\S]+?)["']\s+en\s+([^\s]+)$/i,
  );
  if (replaceMatch) {
    return {
      tool: 'replace_in_file',
      args: {
        search: replaceMatch[1],
        replace: replaceMatch[2],
        path: replaceMatch[3].trim(),
      },
    };
  }

  const globMatch = text.match(/^(?:busca|encuentra)\s+archivos\s+con\s+patron\s+([^\s]+)(?:\s+en\s+([^\s]+))?$/i);
  if (globMatch) {
    return {
      tool: 'glob_files',
      args: {
        pattern: globMatch[1].trim(),
        path: globMatch[2]?.trim() ?? '.',
      },
    };
  }

  const infoMatch = text.match(/^(?:info|informacion)\s+de\s+([^\s]+)$/i);
  if (infoMatch) {
    return {
      tool: 'file_info',
      args: {
        path: infoMatch[1].trim(),
      },
    };
  }

  const readMatch = text.match(
    /^(?:lee|mira|abre)\s+(?:el\s+)?archivo\s+([^\s]+)(?:[\s,]+([\s\S]+))?$/i,
  );
  if (readMatch) {
    return {
      tool: 'read_file',
      args: {
        path: readMatch[1].trim(),
      },
    };
  }

  const readLooseMatch = text.match(/^(?:lee|mira|abre)\s+([/~.\w-][^\s]*)(?:[\s,]+([\s\S]+))?$/i);
  if (readLooseMatch) {
    const candidate = readLooseMatch[1].trim();
    if (/[/\\.]/.test(candidate) || candidate.startsWith('~')) {
      return {
        tool: 'read_file',
        args: {
          path: candidate,
        },
      };
    }
  }

  const listMatch = text.match(
    /^(?:lista|muestra)\s+(?:el\s+)?(?:contenido|directorio|carpeta)(?:\s+([^\s]+))?$/i,
  );
  if (listMatch) {
    return {
      tool: 'list_dir',
      args: {
        path: listMatch[1]?.trim() ?? '.',
      },
    };
  }

  const searchMatch = text.match(
    /^(?:busca|buscar)\s+["']?([\s\S]+?)["']?\s+en\s+([^\s]+)$/i,
  );
  if (searchMatch) {
    return {
      tool: 'search_text',
      args: {
        pattern: searchMatch[1].trim(),
        path: searchMatch[2].trim(),
      },
    };
  }

  return null;
}



module.exports = {
  TOOL_DEFINITIONS,
  cleanCommand,
  cleanUrl,
  describeToolCall,
  executeToolCall,
  getToolPromptText,
  parseDirectAction,
  printTools,
};
