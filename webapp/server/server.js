import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import { WebSocket } from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { register as registerUser, login as loginUser, logout as logoutUser, getSession, getUserHomeDir } from './auth.js';
import { terminalManager } from './terminalManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fileExplorerHome = process.env.FILE_EXPLORER_HOME || '/home/webterm';
const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Auth helpers ----
function extractSessionToken(req) {
  // Try query param first (for WS upgrade) then cookie
  if (req.query && req.query.session) return req.query.session;
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

function authRequired(req, res, next) {
  const token = extractSessionToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const user = getSession(token);
  if (!user) return res.status(401).json({ error: 'Session expired' });
  req.user = user;
  req.sessionToken = token;
  next();
}

// ---- Auth routes ----
app.get('/api/auth/me', async (req, res) => {
  const token = extractSessionToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const user = getSession(token);
  if (!user) return res.status(401).json({ error: 'Session expired' });
  res.json({ authenticated: true, username: user.username, email: user.email, homeDir: getUserHomeDir(user.username) });
});

app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const result = await registerUser({ username, email, password });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await loginUser({ username, password });
    // Set session cookie
    res.cookie('session', result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
    });
    res.json({ authenticated: true, username: result.username, email: result.email, homeDir: getUserHomeDir(result.username) });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = extractSessionToken(req);
  if (token) logoutUser(token);
  res.clearCookie('session');
  res.json({ loggedOut: true });
});

// ---- File System APIs (require auth, isolate per-user) ----
app.get('/api/config', authRequired, (req, res) => {
  res.json({
    fileExplorerHome: getUserHomeDir(req.user.username),
    user: req.user,
  });
});

function sanitizePath(req, reqPath) {
  // If the path starts with /home/users/<username>, strip to just the suffix
  const home = getUserHomeDir(req.user.username);
  if (reqPath.startsWith(home + '/') || reqPath === home) {
    return reqPath;
  }
  // Reject paths outside the user's home
  return null;
}

app.get('/api/files', authRequired, async (req, res) => {
  const dir = req.query.dir || getUserHomeDir(req.user.username);
  // Verify path is within user's home
  const home = getUserHomeDir(req.user.username);
  if (!dir.startsWith(home + '/') && dir !== home) {
    return res.status(403).json({ error: 'Access denied: outside home directory' });
  }
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        let stat;
        try { stat = await fs.stat(fullPath); } catch { return null; }
        if (!stat) return null;
        return {
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          isFile: stat.isFile(),
          isSymlink: entry.isSymbolicLink(),
          size: stat.size,
          modified: stat.mtime,
        };
      })
    ).then(items => items.filter(Boolean));
    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ path: dir, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/files/read', authRequired, async (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'No file specified' });
  const home = getUserHomeDir(req.user.username);
  if (!file.startsWith(home + '/') && file !== home) {
    return res.status(403).json({ error: 'Access denied: outside home directory' });
  }
  try {
    const stat = await fs.stat(file);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Path is a directory' });
    const isImage = /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico|avif)$/i.test(file);
    if (isImage) {
      const data = await fs.readFile(file);
      const ext = path.extname(file).slice(1);
      const mime = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      res.set('Content-Type', mime);
      res.send(data);
    } else {
      const content = await fs.readFile(file, 'utf-8');
      res.json({ content, size: content.length });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/files/list', authRequired, async (req, res) => {
  const dir = req.query.dir || getUserHomeDir(req.user.username);
  const home = getUserHomeDir(req.user.username);
  if (!dir.startsWith(home + '/') && dir !== home) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const items = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      let stat;
      try { stat = await fs.stat(fullPath); } catch { return null; }
      if (!stat) return null;
      return {
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        size: stat.size,
        modified: stat.mtime ? stat.mtime.toISOString().slice(0, 19) : '',
      };
    })).then(items => items.filter(Boolean));
    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files/write', authRequired, async (req, res) => {
  const { file, content } = req.body;
  if (!file || content === undefined) return res.status(400).json({ error: 'Missing file or content' });
  const home = getUserHomeDir(req.user.username);
  if (!file.startsWith(home + '/') && file !== home) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    // Ensure parent dir exists
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf-8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files/upload', authRequired, async (req, res) => {
  const { file, data, encoding } = req.body;
  if (!file || data === undefined) return res.status(400).json({ error: 'Missing file or data' });
  const home = getUserHomeDir(req.user.username);
  const target = path.resolve(file);
  const homePath = path.resolve(home);
  if (!target.startsWith(homePath + path.sep)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const buf = encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data);
    await fs.writeFile(target, buf);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files/mkdir', authRequired, async (req, res) => {
  const { dir } = req.body;
  if (!dir) return res.status(400).json({ error: 'Missing dir' });
  const home = getUserHomeDir(req.user.username);
  if (!dir.startsWith(home + '/') && dir !== home) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    await fs.mkdir(dir, { recursive: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files/delete', authRequired, async (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Missing path' });
  const home = getUserHomeDir(req.user.username);
  if (!filePath.startsWith(home + '/') && filePath !== home) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      await fs.rm(filePath, { recursive: true, force: true });
    } else {
      await fs.unlink(filePath);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- HTTP server for both Express + WebSocket ----
const httpServer = app.listen(3000, '0.0.0.0', () => {
  console.log('Server running on http://0.0.0.0:3000');
});

// WebSocket upgrade handler — per-user terminal sessions
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  // Extract session token from the upgrade URL or cookie
  const token = extractSessionToken({ query: url.searchParams, headers: { cookie: request.headers.cookie || '' } });
  if (!token) {
    socket.destroy();
    return;
  }

  const user = getSession(token);
  if (!user) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (clientWs) => {
    // Extract terminal dimensions from query params
    const cols = parseInt(url.searchParams.get('cols')) || 80;
    const rows = parseInt(url.searchParams.get('rows')) || 24;

    try {
      const session = terminalManager.getSession(user.username, clientWs, cols, rows);
      console.log(`[term] terminal connected for ${user.username} on port ${session.port}`);
    } catch (err) {
      console.error(`[term] Error creating session for ${user.username}:`, err.message);
      clientWs.send(new TextEncoder().encode(JSON.stringify({ type: 'error', message: err.message })));
      clientWs.close();
    }

    // Listen for terminal close to track activity
    clientWs.on('close', () => {
      console.log(`[term] terminal disconnected for ${user.username}`);
    });
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  terminalManager.stop();
  httpServer.close();
  process.exit(0);
});
