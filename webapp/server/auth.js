import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = process.env.DB_DIR || '/home/users';
const SALT_ROUNDS = 10;

// Allowed usernames for registration (empty = open to anyone)
const ALLOWED_USERNAMES = (process.env.ALLOWED_USERNAMES || '')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean);

const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean);

// Ensure DB directory exists
await fs.mkdir(DB_DIR, { recursive: true });
const dbPath = path.join(DB_DIR, 'auth.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// ---- Schema ----
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL REFERENCES users(username),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);
`);

const insertUser = db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)');
const getUserByUsername = db.prepare('SELECT username, email, password_hash FROM users WHERE username = ?');
const getUserByEmail = db.prepare('SELECT username, email, password_hash FROM users WHERE email = ?');
const insertSession = db.prepare('INSERT INTO sessions (token, username) VALUES (?, ?)');
const getSessionStmt = db.prepare(
  'SELECT s.token, s.username, u.email FROM sessions s JOIN users u ON s.username = u.username WHERE s.token = ?'
);
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
const deleteSessionsByUsername = db.prepare('DELETE FROM sessions WHERE username = ?');

// Ensure user home dir exists, return its absolute path
async function ensureUserDir(username) {
  const homeDir = path.join('/home/users', username);
  await fs.mkdir(homeDir, { recursive: true });
  return homeDir;
}

export function getUserHomeDir(username) {
  return path.join('/home/users', username);
}

export async function register({ username, email, password }) {
  if (ALLOWED_USERNAMES.length && !ALLOWED_USERNAMES.includes(username)) {
    throw new Error('Registration is not available for this username');
  }

  const existing = getUserByUsername.get(username);
  if (existing) throw new Error('Username already taken');

  const existingEmail = getUserByEmail.get(email);
  if (existingEmail) throw new Error('Email already registered');

  const pwHash = await bcrypt.hash(password, SALT_ROUNDS);
  const homeDir = await ensureUserDir(username);

  // Write a pretty .bashrc for the new user
  const bashrc = `
# ~/.bashrc

# Source global definitions
if [ -f /etc/bashrc ]; then
    . /etc/bashrc
fi

# User specific environment
if ! [[ "$PATH" =~ "$HOME/.local/bin:$HOME/bin:" ]]; then
    PATH="$HOME/.local/bin:$HOME/bin:$PATH"
fi
export PATH

# Pretty prompt
PS1='\\[\\e[01;32m\\]][\\u\\[\\e[01;37m\\]] @ \\[\\e[01;36m\\][\\H\\[\\e[00;37m\\]] [\\[\\e[01;35m\\]\\w\\[\\e[00;32m\\]]\\$ \\[\\e[0m\\]'

# Enable color support
export CLICOLOR=1
export LSCOLORS=Exfxcxdxbxegedabagacad
alias ls="ls -G"
alias grep="grep --color=auto"

# History
export HISTSIZE=10000
export HISTFILE=~/.bash_history
shopt -s histappend
shopt -s cmdhist
shopt -s hostcomplete
shopt -s extglob

# Environment variables
export EDITOR=vim
export VISUAL=vim
`;

  await fs.writeFile(path.join(homeDir, '.bashrc'), bashrc.trimStart() + '\n', 'utf-8');

  insertUser.run(username, email, pwHash);
  return { username, email };
}

export async function login({ username, password }) {
  const user = getUserByUsername.get(username);
  if (!user) throw new Error('Invalid credentials');
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new Error('Invalid credentials');
  const token = crypto.randomBytes(32).toString('hex');
  insertSession.run(token, username);
  return { token, username, email: user.email };
}

export async function logout(token) {
  deleteSession.run(token);
}

/**
 * Validate a session token and return { username, email } or null.
 */
export function getSession(token) {
  if (!token || typeof token !== 'string') return null;
  const row = getSessionStmt.get(token);
  if (!row) return null;
  return { username: row.username, email: row.email };
}

export function invalidateUserSessions(username) {
  deleteSessionsByUsername.run(username);
}

export async function ensureDir(pathStr) {
  await fs.mkdir(pathStr, { recursive: true });
}

export function isAdmin(username) {
  return ADMIN_USERNAMES.length > 0 && ADMIN_USERNAMES.includes(username);
}

const listAllUsers = db.prepare('SELECT username FROM users');
export function listUsernames() {
  return listAllUsers.all().map(r => r.username);
}
