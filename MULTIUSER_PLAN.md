# Multi-User Implementation Plan

## Overview

Convert the single-user web terminal into a multi-user platform where visitors can register accounts and get their own isolated terminal + file explorer.

## Architecture

```
┌──────────── Browser ────────────┐
│  Login/Register │ Terminal │ Files│
│            ▲ Session cookie     │
└──────────────┼──────────────────┘
               │
      ┌────────▼────────┐
      │  webapp (:3000) │  Express + WS proxy + auth + ttyd pool
      │  REST + Auth +  │  (single container, manages everything)
      │  ttyd manager   │
      └─────────────────┘

Per-user (on-demand):
  ┌───────────┐
  │ ttyd proc  │  → bash as user:<username>
  │ :dynamic   │  → home: /home/<username>
  └───────────┘
```

Key design decisions:
- **One ttyd process per active logged-in user**, spawned on-demand by the webapp's terminal manager
- **Each user gets a home directory** at `/home/<username>` inside the webapp container (persistent via Docker volumes)
- **All in one container** — ttyd binary lives alongside Node; no separate ttyd service needed
- **Session cookie auth** — no JWT needed, just a secure httpOnly cookie tied to SQLite session
- **User isolation** — each ttyd process runs `su <username> bash -l`, each API request uses `thisUser.homeDir` from their session

## Changes Required

### 1. webapp/server/Dockerfile (already done)
- [x] Add ttyd binary download (Alpine wget → copy from helper stage) and tini
- [x] Keep existing node/bash/python deps

### 2. docker-compose.yml
- [x] Remove standalone `ttyd` service (webapp spawns ttyd internally now)
- [x] Per-user volumes will be created dynamically via Docker API at registration time

### 3. webapp/server/auth.js (new file)
- [x] SQLite DB init (users table + sessions table)
- [x] `register(username, email, password)` — bcrypt hash, insert
- [x] `login(username, password)` — verify, create session, return session token
- [x] `getBySession(token)` — validate session, return user
- [x] `logout(token)` — invalidate session
- [x] `getOrCreateUserDir(username)` — creates username home dir at `/home/<username>`

### 4. webapp/server/server.js (modified)
- [x] Import auth module
- [x] Add `sessionMiddleware` — reads session cookie, attaches `req.user`
- [x] Add `authRequired` middleware for API routes
- [x] Add `GET /api/auth/me` — returns current user info
- [x] Add `POST /api/auth/register` — register endpoint
- [x] Add `POST /api/auth/login` — login endpoint
- [x] Add `POST /api/auth/logout` — logout endpoint
- [x] File APIs: prepend user's homeDir to all paths
- [x] Terminal WS upgrade: extract username from session cookie, find or spawn ttyd for that user
- [x] `TerminalManager` — map of username → { port, proc, ws } with spawn/kill lifecycle

### 5. webapp/server/public/index.html (modified)
- [x] Add login/register overlay screens with styled forms
- [x] Conditionally show auth screens vs terminal UI based on `window.authState`
- [x] Terminal WebSocket connection: include session cookie automatically
- [x] Initial load: fetch `/api/auth/me`, gate access, set `window.authState`

### 6. Bug fixes (applied before testing)
- [x] auth.js: `const getSession` (prepared stmt) renamed to `getSessionStmt` — was a fatal SyntaxError in ES module strict mode
- [x] auth.js: `getSessionStmt` query now JOINs users table so `row.email` is populated
- [x] auth.js: `getUserHomeDir` exported directly (was only a local function; server.js and terminalManager.js couldn't import it)
- [x] terminalManager.js: ttyd auth message now actually sent to ttyd (`ttydWs.send(JSON.stringify({AuthToken: ''}))`) — was constructed but never sent
- [x] terminalManager.js: resize prefix fixed `0x01` → `0x31` ('1') — was sending wrong ttyd protocol byte
- [x] terminalManager.js: removed invalid ttyd flags `-H '*'` and `--display-connect-options 0` — would cause ttyd to exit immediately
- [x] index.html: complete script rewrite — most JS functions were outside any `<script>` tag (broken structure), duplicate `initTerminal` IIFEs removed, `initTerminal()` is now a proper callable function only invoked after auth, all file API calls include `credentials: 'include'`

### 7. Testing
- [ ] Verify registration flow works
- [ ] Verify login/logout flow
- [ ] Verify user1 cannot see user2's files
- [ ] Verify terminal connects and works per-user
- [ ] Verify ttyd process spawning/termination works
- [ ] Verify user home dir persistence across restarts
