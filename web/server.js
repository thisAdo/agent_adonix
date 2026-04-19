const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('./store');
const githubApi = require('./githubApi');
const { runWebAgent } = require('./webAgent');
const { MODELS, DEFAULT_MODEL_KEY } = require('../src/config');

const app = express();
const PORT = process.env.PORT || 3000;

// Evitar crashes silenciosos
process.on('uncaughtException', (err) => {
  console.error('[FATAL]', err.message, err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED]', err);
});

app.use(express.json({ limit: '5mb' }));
// No cache para HTML
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
// Persistir secreto de sesión en disco
const SECRET_FILE = path.join(__dirname, 'data', '.session-secret');
let sessionSecret;
try {
  sessionSecret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} catch {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  fs.writeFileSync(SECRET_FILE, sessionSecret);
}

app.use(session({
  store: new FileStore({
    path: path.join(__dirname, 'data', 'sessions'),
    ttl: 30 * 24 * 60 * 60,
    retries: 0,
    logFn: () => {},
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true },
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ─── Auth ────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    if (username.length < 3 || password.length < 4) {
      return res.status(400).json({ error: 'Mínimo 3 chars usuario, 4 chars contraseña' });
    }
    if (store.getUser(username)) {
      return res.status(409).json({ error: 'El usuario ya existe' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    store.createUser({ username, passwordHash });
    req.session.userId = username;
    res.json({ success: true, username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = store.getUser(username);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    req.session.userId = username;
    res.json({ success: true, username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = store.getUser(req.session.userId);
  res.json({
    username: user.username,
    hasGithub: !!user.githubToken,
    githubEmail: user.githubEmail || '',
    githubUsername: user.githubUsername || '',
  });
});

// ─── Settings ────────────────────────────────────────

app.put('/api/settings', requireAuth, async (req, res) => {
  try {
    const { githubToken, githubEmail } = req.body;
    const updates = {};

    if (githubToken) {
      const profile = await githubApi.validateToken(githubToken);
      if (!profile) {
        return res.status(400).json({ error: 'Token de GitHub inválido o expirado' });
      }
      updates.githubToken = githubToken;
      updates.githubUsername = profile.login || '';
      updates.githubName = profile.name || profile.login || '';
      updates.githubEmail = githubEmail || profile.email || '';
    } else if (githubEmail !== undefined) {
      updates.githubEmail = githubEmail;
    }

    store.updateUser(req.session.userId, updates);
    res.json({ success: true, githubUsername: updates.githubUsername || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Models ──────────────────────────────────────────

app.get('/api/models', requireAuth, (req, res) => {
  const models = Object.entries(MODELS).map(([key, val]) => ({
    key,
    label: val.label,
    provider: val.provider,
  }));
  res.json({ models, default: DEFAULT_MODEL_KEY });
});

// ─── GitHub ──────────────────────────────────────────

app.get('/api/repos', requireAuth, async (req, res) => {
  try {
    const user = store.getUser(req.session.userId);
    if (!user.githubToken) {
      return res.status(400).json({ error: 'Configura tu token de GitHub primero' });
    }
    const repos = await githubApi.listRepos(user.githubToken);
    res.json(repos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/repos/:owner/:repo/tree', requireAuth, async (req, res) => {
  try {
    const user = store.getUser(req.session.userId);
    const tree = await githubApi.getTree(
      user.githubToken, req.params.owner, req.params.repo,
    );
    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Chats ───────────────────────────────────────────

app.get('/api/chats', requireAuth, (req, res) => {
  res.json(store.getUserChats(req.session.userId));
});

app.post('/api/chats', requireAuth, (req, res) => {
  const { repoOwner, repoName } = req.body;
  if (!repoOwner || !repoName) {
    return res.status(400).json({ error: 'Repo requerido' });
  }
  const chat = store.createChat(req.session.userId, repoOwner, repoName);
  res.json(chat);
});

app.get('/api/chats/:id', requireAuth, (req, res) => {
  const chat = store.getChat(req.params.id);
  if (!chat || chat.userId !== req.session.userId) {
    return res.status(404).json({ error: 'Chat no encontrado' });
  }
  res.json(chat);
});

app.put('/api/chats/:id/settings', requireAuth, (req, res) => {
  const chat = store.getChat(req.params.id);
  if (!chat || chat.userId !== req.session.userId) {
    return res.status(404).json({ error: 'Chat no encontrado' });
  }
  const { activeModel, concuerdo } = req.body;
  if (activeModel !== undefined) chat.activeModel = activeModel;
  if (concuerdo !== undefined) chat.concuerdo = concuerdo;
  store.saveChat(chat);
  res.json({ success: true, activeModel: chat.activeModel, concuerdo: chat.concuerdo });
});

app.delete('/api/chats/:id', requireAuth, (req, res) => {
  const chat = store.getChat(req.params.id);
  if (!chat || chat.userId !== req.session.userId) {
    return res.status(404).json({ error: 'Chat no encontrado' });
  }
  store.deleteChat(req.params.id);
  res.json({ success: true });
});

// ─── Chat Send (SSE streaming) ──────────────────────

app.post('/api/chats/:id/send', requireAuth, async (req, res) => {
  const chat = store.getChat(req.params.id);
  if (!chat || chat.userId !== req.session.userId) {
    return res.status(404).json({ error: 'Chat no encontrado' });
  }

  const user = store.getUser(req.session.userId);
  if (!user.githubToken) {
    return res.status(400).json({ error: 'Configura tu token de GitHub' });
  }

  const { message } = req.body;
  if (!message?.trim()) {
    return res.status(400).json({ error: 'Mensaje vacio' });
  }

  chat.messages.push({ role: 'user', content: message.trim(), ts: Date.now() });
  store.saveChat(chat);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    await runWebAgent({
      chatData: chat,
      user,
      onEvent: (event) => {
        if (!aborted) res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      isAborted: () => aborted,
    });
  } catch (err) {
    console.error(`[Agent Error] ${err.message}`);
    if (!aborted) {
      res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
    }
  }

  if (!aborted) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ─── SPA fallback ────────────────────────────────────

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  ● Adonix Web → http://localhost:${PORT}\n`);
});
