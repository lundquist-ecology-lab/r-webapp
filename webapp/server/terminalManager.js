import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pty = require('node-pty');

import fs from 'fs/promises';
import path from 'path';
import { getUserHomeDir } from './auth.js';

export const SKEL_DIR = process.env.SKEL_DIR || '/home/users/.skel';

async function copySkelDir(src, dest) {
  let entries;
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copySkelDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath, fs.constants.COPYFILE_EXCL).catch(() => {});
    }
  }
}

export async function syncSkelFiles(homeDir) {
  await copySkelDir(SKEL_DIR, homeDir).catch((err) => {
    console.error('[skel] sync error:', err.message);
  });
}

async function ensureBashrc(username, homeDir) {
  const bashrcPath = path.join(homeDir, '.bashrc');
  const ps1 = `\\[\\e[96m\\]${username}\\[\\e[90m\\] → \\[\\e[93m\\]\\w\\[\\e[0m\\] \\[\\e[92m\\]\\$\\[\\e[0m\\] `;
  const ps1Line = `PS1='${ps1}'`;

  let existing = '';
  try {
    existing = await fs.readFile(bashrcPath, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (existing.includes(ps1Line)) return;

  const stripped = existing
    .split('\n')
    .filter(line => !/^(export\s+)?PS1=/.test(line.trim()))
    .join('\n')
    .trimEnd();

  await fs.writeFile(bashrcPath, (stripped ? stripped + '\n' : '') + ps1Line + '\n', 'utf-8');
}

const IDLE_TIMEOUT = 30 * 60 * 1000;

class PtySession {
  constructor(username, cols, rows) {
    this.username = username;
    this.clientWs = null;
    this.lastActivity = Date.now();

    const homeDir = getUserHomeDir(username);
    this.proc = pty.spawn('bash', [], {
      name: 'xterm-256color',
      cols: Math.max(1, cols || 80),
      rows: Math.max(1, rows || 24),
      cwd: homeDir,
      env: { ...process.env, HOME: homeDir, USER: username, TERM: 'xterm-256color' },
    });

    this.proc.onData((data) => {
      this.lastActivity = Date.now();
      if (this.clientWs && this.clientWs.readyState === 1 /* OPEN */) {
        const payload = Buffer.concat([Buffer.from([0x30]), Buffer.from(data)]);
        this.clientWs.send(payload, { binary: true });
      }
    });

    this.proc.onExit(({ exitCode }) => {
      console.log(`[pty] bash for ${username} exited (code ${exitCode})`);
      if (this.clientWs) {
        try { this.clientWs.close(); } catch {}
        this.clientWs = null;
      }
    });

    console.log(`[pty] spawned bash for ${username} (pid ${this.proc.pid})`);
  }

  attach(clientWs, cols, rows) {
    if (this.clientWs && this.clientWs !== clientWs) {
      try { this.clientWs.close(); } catch {}
    }
    this.clientWs = clientWs;
    this.lastActivity = Date.now();

    try { this.proc.resize(Math.max(1, cols), Math.max(1, rows)); } catch {}

    clientWs.on('message', (msg) => {
      const data = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      if (data.length === 0) return;
      this.lastActivity = Date.now();
      if (data[0] === 0x30) { // '0' = INPUT
        try { this.proc.write(data.slice(1).toString()); } catch {}
      } else if (data[0] === 0x31) { // '1' = RESIZE
        try {
          const { columns, rows: r } = JSON.parse(data.slice(1).toString());
          if (columns > 0 && r > 0) this.proc.resize(columns, r);
        } catch {}
      }
    });

    clientWs.on('close', () => {
      if (this.clientWs === clientWs) this.clientWs = null;
    });
  }

  kill() {
    try { this.proc.kill(); } catch {}
    if (this.clientWs) {
      try { this.clientWs.close(); } catch {}
      this.clientWs = null;
    }
  }
}

class TerminalManager {
  constructor() {
    this.sessions = new Map();
    this._cleanupInterval = setInterval(() => this._cleanupIdle(), 60_000);
    this._cleanupInterval.unref();
  }

  async getSession(username, clientWs, cols, rows) {
    let session = this.sessions.get(username);
    if (!session) {
      const homeDir = getUserHomeDir(username);
      await ensureBashrc(username, homeDir);
      await syncSkelFiles(homeDir);
      session = new PtySession(username, cols, rows);
      this.sessions.set(username, session);
    }
    session.attach(clientWs, cols, rows);
    return session;
  }

  killSession(username) {
    const session = this.sessions.get(username);
    if (session) {
      session.kill();
      this.sessions.delete(username);
    }
  }

  _cleanupIdle() {
    const now = Date.now();
    for (const [username, session] of this.sessions) {
      if (now - session.lastActivity > IDLE_TIMEOUT) {
        session.kill();
        this.sessions.delete(username);
        console.log(`[pty] idle session cleaned up for ${username}`);
      }
    }
  }

  stop() {
    clearInterval(this._cleanupInterval);
    for (const [, session] of this.sessions) session.kill();
    this.sessions.clear();
  }
}

export const terminalManager = new TerminalManager();
