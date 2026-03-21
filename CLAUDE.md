# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A local web dashboard for monitoring ticket availability at Maccabi Haifa FC (מכבי חיפה) games at Sami Ofer Stadium. It uses Playwright to scan the ticketing site for available seats, and alerts via Telegram when tickets are found.

## Running the project

```bash
npm start         # starts the server at http://localhost:3000
node server.js    # same thing
```

Open `http://localhost:3000` in your browser to see the dashboard.

First-time setup:
```bash
npm install
npx playwright install chromium
```

Optional stealth mode (reduces detection):
```bash
npm install playwright-extra playwright-extra-plugin-stealth
```

## Architecture

Three core files:

- **`server.js`** — Express HTTP server + WebSocket server. Serves the static frontend, exposes REST API (`/api/settings`, `/api/monitor/start`, `/api/monitor/stop`, `/api/status`), and forwards Monitor events to all connected browser clients via WebSocket.

- **`monitor.js`** — `Monitor extends EventEmitter`. Manages the Playwright browser lifecycle (launch, login, monitoring loop). Emits: `log`, `status`, `sections`, `stats`, `alert`. The `start()` method is async but `_runLoop()` runs detached (not awaited), so it doesn't block the HTTP response.

- **`public/`** — Static frontend (vanilla HTML/CSS/JS, no build step needed).
  - `index.html` — layout
  - `style.css` — dark theme dashboard styles
  - `app.js` — WebSocket client, renders sections grid, handles settings form, controls

## Data flow

```
Browser (dashboard)  ←──WebSocket──→  server.js  ←──events──  monitor.js
                     ←──REST API───→                         ──Playwright──→ mhaifafc.com
```

## Key files (do NOT commit)

- `state.json` — saved Playwright browser session (cookies + localStorage)
- `.env` — credentials
- `settings.json` — saved dashboard settings (created on first save; contains Telegram token + login credentials)

## Environment variables (`.env`)

These pre-fill the settings on first run:
- `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`
- `LOGIN_USERNAME`, `LOGIN_PASSWORD`
- `PORT` (default: 3000)
