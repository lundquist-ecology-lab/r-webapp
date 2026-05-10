import express from 'express';
import cors from 'cors';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// File system APIs
app.get('/api/files', async (req, res) => {
  const dir = req.query.dir || '/';
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const items = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        return { name: entry.name, path: fullPath, isDirectory: entry.isDirectory(), isFile: entry.isFile(), isSymlink: entry.isSymbolicLink() };
      }
      return {
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymlink: entry.isSymbolicLink(),
        size: stat.size,
        modified: stat.mtime,
      };
    }));
    // Sort: directories first, then by name
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

// Terminal via pty
let ptyProcess = null;
const wss = new WebSocketServer({ noServer: true });

const httpServer = app.listen(3000, '0.0.0.0', () => {
  console.log('Server running on http://0.0.0.0:3000');
});

httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  ptyProcess = pty.spawn('bash', [], {
    cols: 80,
    rows: 24,
    name: 'xterm-256color',
    env: { ...process.env, TERM: 'xterm-256color', HOME: '/root' },
  });

  ptyProcess.on('data', (data) => {
    ws.send(JSON.stringify({ type: 'output', data: Buffer.from(data).toString('base64') }));
  });

  ptyProcess.on('exit', (code) => {
    ws.send(JSON.stringify({ type: 'close', code }));
    ws.close();
  });

  ws.on('message', (msg) => {
    const { type, data } = JSON.parse(msg);
    if (type === 'input' && ptyProcess) {
      ptyProcess.write(Buffer.from(data, 'base64').toString());
    } else if (type === 'resize' && ptyProcess) {
      ptyProcess.resize(data.cols, data.rows);
    }
  });

  ws.on('close', () => {
    ptyProcess?.kill();
    ptyProcess = null;
  });
});
