const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHATS_DIR = path.join(DATA_DIR, 'chats');

fs.mkdirSync(CHATS_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

function readUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function getUser(username) {
  return readUsers().find(u => u.username === username) || null;
}

function createUser(data) {
  const users = readUsers();
  users.push({
    ...data,
    githubToken: '',
    githubEmail: '',
    githubUsername: '',
    githubName: '',
    createdAt: Date.now(),
  });
  writeUsers(users);
}

function updateUser(username, updates) {
  const users = readUsers();
  const idx = users.findIndex(u => u.username === username);
  if (idx !== -1) {
    Object.assign(users[idx], updates);
    writeUsers(users);
  }
}

function createChat(userId, repoOwner, repoName) {
  const id = crypto.randomUUID();
  const chat = {
    id,
    userId,
    repoOwner,
    repoName,
    title: `${repoOwner}/${repoName}`,
    messages: [],
    createdAt: Date.now(),
  };
  fs.writeFileSync(path.join(CHATS_DIR, `${id}.json`), JSON.stringify(chat, null, 2));
  return chat;
}

function getChat(id) {
  const file = path.join(CHATS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveChat(chat) {
  fs.writeFileSync(
    path.join(CHATS_DIR, `${chat.id}.json`),
    JSON.stringify(chat, null, 2),
  );
}

function getUserChats(userId) {
  const files = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.json'));
  return files
    .map(f => JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf8')))
    .filter(c => c.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ id, title, repoOwner, repoName, createdAt, messages }) => ({
      id,
      title,
      repoOwner,
      repoName,
      createdAt,
      lastMessage: messages[messages.length - 1]?.content?.slice(0, 100) || '',
    }));
}

function deleteChat(id) {
  const file = path.join(CHATS_DIR, `${id}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = {
  getUser,
  createUser,
  updateUser,
  createChat,
  getChat,
  saveChat,
  getUserChats,
  deleteChat,
};
