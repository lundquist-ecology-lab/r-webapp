import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import { WebSocket } from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { register as registerUser, login as loginUser, logout as logoutUser, getSession, getUserHomeDir, isAdmin, listUsernames } from './auth.js';
import { terminalManager, SKEL_DIR, syncSkelFiles } from './terminalManager.js';

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

function adminRequired(req, res, next) {
  const token = extractSessionToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const user = getSession(token);
  if (!user) return res.status(401).json({ error: 'Session expired' });
  if (!isAdmin(user.username)) return res.status(403).json({ error: 'Admin access required' });
  req.user = user;
  next();
}

// ---- Auth routes ----
app.get('/api/auth/me', async (req, res) => {
  const token = extractSessionToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const user = getSession(token);
  if (!user) return res.status(401).json({ error: 'Session expired' });
  res.json({ authenticated: true, username: user.username, email: user.email, homeDir: getUserHomeDir(user.username), isAdmin: isAdmin(user.username) });
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
    res.json({ authenticated: true, username: result.username, email: result.email, homeDir: getUserHomeDir(result.username), isAdmin: isAdmin(result.username) });
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
  const home = path.resolve(getUserHomeDir(req.user.username));
  const resolved = path.resolve(reqPath);
  if (resolved !== home && !resolved.startsWith(home + path.sep)) {
    return null;
  }
  return resolved;
}

app.get('/api/files', authRequired, async (req, res) => {
  const dir = req.query.dir || getUserHomeDir(req.user.username);
  const safeDir = sanitizePath(req, dir);
  if (!safeDir) return res.status(403).json({ error: 'Access denied: outside home directory' });
  try {
    const entries = await fs.readdir(safeDir, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(safeDir, entry.name);
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
    res.json({ path: safeDir, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/files/read', authRequired, async (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'No file specified' });
  const safeFile = sanitizePath(req, file);
  if (!safeFile) return res.status(403).json({ error: 'Access denied: outside home directory' });
  try {
    const stat = await fs.stat(safeFile);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Path is a directory' });
    const isImage = /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico|avif)$/i.test(safeFile);
    if (isImage) {
      const data = await fs.readFile(safeFile);
      const ext = path.extname(safeFile).slice(1);
      const mime = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      res.set('Content-Type', mime);
      res.send(data);
    } else {
      const content = await fs.readFile(safeFile, 'utf-8');
      res.json({ content, size: content.length });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/files/download', authRequired, async (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'No file specified' });
  const safeFile = sanitizePath(req, file);
  if (!safeFile) return res.status(403).json({ error: 'Access denied: outside home directory' });
  try {
    const stat = await fs.stat(safeFile);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Cannot download a directory' });
    res.download(safeFile, path.basename(safeFile));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/files/list', authRequired, async (req, res) => {
  const dir = req.query.dir || getUserHomeDir(req.user.username);
  const safeDir = sanitizePath(req, dir);
  if (!safeDir) return res.status(403).json({ error: 'Access denied' });
  try {
    const entries = await fs.readdir(safeDir, { withFileTypes: true });
    const items = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(safeDir, entry.name);
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
  const safeFile = sanitizePath(req, file);
  if (!safeFile) return res.status(403).json({ error: 'Access denied' });
  try {
    await fs.mkdir(path.dirname(safeFile), { recursive: true });
    await fs.writeFile(safeFile, content, 'utf-8');
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
  const safeDir = sanitizePath(req, dir);
  if (!safeDir) return res.status(403).json({ error: 'Access denied' });
  try {
    await fs.mkdir(safeDir, { recursive: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files/delete', authRequired, async (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Missing path' });
  const safePath = sanitizePath(req, filePath);
  if (!safePath) return res.status(403).json({ error: 'Access denied' });
  try {
    const stat = await fs.stat(safePath);
    if (stat.isDirectory()) {
      await fs.rm(safePath, { recursive: true, force: true });
    } else {
      await fs.unlink(safePath);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin skel management ----

function sanitizeSkelPath(reqPath) {
  const skelBase = path.resolve(SKEL_DIR);
  const resolved = path.resolve(reqPath);
  if (resolved !== skelBase && !resolved.startsWith(skelBase + path.sep)) return null;
  return resolved;
}

async function pushSkelToAllUsers() {
  const usernames = listUsernames();
  await Promise.all(usernames.map(username =>
    syncSkelFiles(getUserHomeDir(username)).catch(() => {})
  ));
}

app.get('/api/admin/skel/list', adminRequired, async (req, res) => {
  const dir = req.query.dir || SKEL_DIR;
  const safeDir = sanitizeSkelPath(dir);
  if (!safeDir) return res.status(403).json({ error: 'Access denied' });
  try {
    await fs.mkdir(safeDir, { recursive: true });
    const entries = await fs.readdir(safeDir, { withFileTypes: true });
    const items = await Promise.all(entries.map(async entry => {
      const fullPath = path.join(safeDir, entry.name);
      let stat;
      try { stat = await fs.stat(fullPath); } catch { return null; }
      return { name: entry.name, path: fullPath, isDirectory: entry.isDirectory(), isFile: stat.isFile(), size: stat.size, modified: stat.mtime };
    })).then(items => items.filter(Boolean));
    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ path: safeDir, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/skel/read', adminRequired, async (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'No file specified' });
  const safeFile = sanitizeSkelPath(file);
  if (!safeFile) return res.status(403).json({ error: 'Access denied' });
  try {
    const stat = await fs.stat(safeFile);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Path is a directory' });
    const content = await fs.readFile(safeFile, 'utf-8');
    res.json({ content, size: content.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/skel/write', adminRequired, async (req, res) => {
  const { file, content } = req.body;
  if (!file || content === undefined) return res.status(400).json({ error: 'Missing file or content' });
  const safeFile = sanitizeSkelPath(file);
  if (!safeFile) return res.status(403).json({ error: 'Access denied' });
  try {
    await fs.mkdir(path.dirname(safeFile), { recursive: true });
    await fs.writeFile(safeFile, content, 'utf-8');
    pushSkelToAllUsers().catch(err => console.error('[skel] push error:', err.message));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/skel/upload', adminRequired, async (req, res) => {
  const { file, data, encoding } = req.body;
  if (!file || data === undefined) return res.status(400).json({ error: 'Missing file or data' });
  const safeFile = sanitizeSkelPath(file);
  if (!safeFile) return res.status(403).json({ error: 'Access denied' });
  try {
    await fs.mkdir(path.dirname(safeFile), { recursive: true });
    const buf = encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data);
    await fs.writeFile(safeFile, buf);
    pushSkelToAllUsers().catch(err => console.error('[skel] push error:', err.message));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/skel/delete', adminRequired, async (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Missing path' });
  const safePath = sanitizeSkelPath(filePath);
  if (!safePath) return res.status(403).json({ error: 'Access denied' });
  try {
    const stat = await fs.stat(safePath);
    if (stat.isDirectory()) {
      await fs.rm(safePath, { recursive: true, force: true });
    } else {
      await fs.unlink(safePath);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/skel/download', adminRequired, async (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'No file specified' });
  const safeFile = sanitizeSkelPath(file);
  if (!safeFile) return res.status(403).json({ error: 'Access denied' });
  try {
    const stat = await fs.stat(safeFile);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Cannot download a directory' });
    res.download(safeFile, path.basename(safeFile));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/skel/push', adminRequired, async (req, res) => {
  try {
    await pushSkelToAllUsers();
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

  wss.handleUpgrade(request, socket, head, async (clientWs) => {
    // Extract terminal dimensions from query params
    const cols = parseInt(url.searchParams.get('cols')) || 80;
    const rows = parseInt(url.searchParams.get('rows')) || 24;

    try {
      const session = await terminalManager.getSession(user.username, clientWs, cols, rows);
      console.log(`[term] terminal connected for ${user.username}`);
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
