import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import { WebSocket } from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fileExplorerHome = process.env.FILE_EXPLORER_HOME || '/home/webterm';
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ fileExplorerHome });
});

// File system APIs
app.get('/api/files', async (req, res) => {
  const dir = req.query.dir || fileExplorerHome;
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

app.get('/api/files/read', async (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'No file specified' });
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

app.get('/api/files/list', async (req, res) => {
  const dir = req.query.dir || fileExplorerHome;
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

app.post('/api/files/write', async (req, res) => {
  const { file, content } = req.body;
  if (!file || content === undefined) return res.status(400).json({ error: 'Missing file or content' });
  try {
    await fs.writeFile(file, content, 'utf-8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files/upload', async (req, res) => {
  const { file, data, encoding } = req.body;
  if (!file || !data) return res.status(400).json({ error: 'Missing file or data' });
  try {
    const buf = encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data);
    await fs.writeFile(file, buf);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files/mkdir', async (req, res) => {
  const { dir } = req.body;
  if (!dir) return res.status(400).json({ error: 'Missing dir' });
  try {
    await fs.mkdir(dir, { recursive: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files/delete', async (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Missing path' });
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

// HTTP server for both Express + WebSocket
const httpServer = app.listen(3000, '0.0.0.0', () => {
  console.log('Server running on http://0.0.0.0:3000');
});

// Transparent WebSocket proxy to ttyd — no encoding, raw binary passthrough
const wss = new WebSocketServer({ noServer: true });
const TTYD_URL = 'ws://ttyd:7681/ws';

httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (clientWs) => {
    const pending = [];
    const ttydWs = new WebSocket(TTYD_URL, 'tty', { perMessageDeflate: false });

    ttydWs.on('open', () => {
      for (const [data, isBinary] of pending) ttydWs.send(data, { binary: isBinary });
      pending.length = 0;
    });

    ttydWs.on('message', (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
    });

    clientWs.on('message', (data, isBinary) => {
      if (ttydWs.readyState === WebSocket.OPEN) ttydWs.send(data, { binary: isBinary });
      else pending.push([data, isBinary]);
    });

    ttydWs.on('close', () => { if (clientWs.readyState === WebSocket.OPEN) clientWs.close(); });
    ttydWs.on('error', (err) => { console.error('ttyd:', err.message); clientWs.close(); });
    clientWs.on('close', () => ttydWs.close());
  });
});
