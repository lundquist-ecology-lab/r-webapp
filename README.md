# r-webapp

A web-based remote terminal and file explorer deployed via Docker Compose.

## Overview

`r-webapp` provides a browser-accessible terminal session tied to a file management UI, all served from a single Docker Compose stack. It consists of three components:

- **webapp** — An Express.js + Node.js server that serves the frontend UI, exposes REST APIs for file operations (list, read, write, upload, mkdir, delete), and transparently proxies WebSocket traffic to ttyd for live terminal I/O.
- **ttyd** — [ttyd](https://github.com/tsl0922/ttyd), a lightweight single-command terminal emulator, running inside its own container. The webapp forwards WebSocket frames between the browser and ttyd with no encoding or transformation.
- **frontend** — A split-pane web UI (terminal on the left, file explorer on the right) built with [xterm.js](https://xtermjs.org/). Features include:
  - File browsing and navigation
  - Text file editor with save support
  - Image preview for common image formats
  - Resizable terminal and file panel
  - Right-click context menu with path copy and delete

## Architecture

```
┌────────────── Browser ──────────────┐
│  Split pane: Terminal │ File Explorer│
│              ▲ WebSocket (ws)       │
└──────────────┼──────────────────────┘
               │
      ┌────────▼─────────┐
      │  webapp (:3000)  │  Express + WS proxy
      │  REST APIs + Ws  │
      │  proxy → ttyd    │
      └────────┬─────────┘
               │ WS → :7681
      ┌────────▼─────────┐
      │    ttyd (:7681)  │  Runs `bash`
      └──────────────────┘
```

## Running

Install [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/), then from the project root:

```bash
docker compose up --build
```

This starts two services:

| Service | Container | Port | Description |
|---------|-----------|------|-------------|
| `webapp` | `webterminal` | `3000` | Express server + file API + WS proxy |
| `ttyd` | `ttyd` | `7681` | Terminal backend (runs `bash`) |

Visit **http://localhost:3000** in your browser to use the terminal and file explorer.

### File system access

The `webterminal` container mounts the host root as `/host` (`/:/host` in `docker-compose.yml`). File API operations that reference absolute paths outside `/` will map into the host filesystem.

## Local development

```bash
# Start the full stack
docker compose up --build

# Or start just the webapp locally
cd webapp/server
npm install
npm run dev
```

## Config

### ttyd

Edit `webapp/ttyd.conf` to change ttyd's host, port, SSL, or logging settings.

### Docker Compose

Edit `docker-compose.yml` to change ports, environment variables (e.g. `TZ`), container restart policies, or volume mounts.

## File API

The Express server exposes the following REST endpoints on `/:3000`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/files?dir=&lt;path&gt;` | List directory contents |
| `GET` | `/api/files/list?dir=&lt;path&gt;` | List directory (compact) |
| `GET` | `/api/files/read?file=&lt;path&gt;` | Read file or image |
| `POST` | `/api/files/write` | Write file (body: `{ file, content }`) |
| `POST` | `/api/files/upload` | Upload file (body: `{ file, data, encoding }`) |
| `POST` | `/api/files/mkdir` | Create directory (body: `{ dir }`) |
| `POST` | `/api/files/delete` | Delete file or directory (body: `{ path }`) |

## Project structure

```
r-webapp/
├── docker-compose.yml    # Stack definition
├── README.md
├── webapp/
│   ├── Dockerfile        # Frontend build (Vite → nginx)
│   ├── server/
│   │   ├── Dockerfile    # Express server container
│   │   ├── package.json
│   │   ├── server.js     # Main Express + WS proxy server
│   │   ├── public/
│   │   │   ├── index.html
│   │   │   ├── xterm.min.js
│   │   │   └── xterm.css
│   │   └── ttyd.conf     # ttyd configuration
└── webterminal/
    └── Dockerfile        # ttyd container from Alpine
```
