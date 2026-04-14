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

## How availability detection works

The ticketing site (`tickets.mhaifafc.com`) renders a seat map SVG. Available sections appear as `li.collection-item` elements with an `onclick` attribute calling `stadium.processSectorById(sectorId)`. Their text content contains the Hebrew "גוש X" (Block X) where X is the section number.

**Key insight:** Sold-out sections are *absent* from this list — no element exists for them at all. So detection is: read which section numbers appear in the list → present = available, absent = unavailable.

```javascript
// In monitor.js _checkAvailability()
Array.from(document.querySelectorAll('[onclick*="processSectorById"]'))
  .map(el => { const m = el.textContent.match(/גוש\s*(\d+)/); return m ? m[1] : null; })
  .filter(Boolean);
```

**Section numbers** on this site are small integers (e.g. 12, 13, 16, 17…), NOT the 3-digit numbers shown in the `STADIUM_ZONES` object in `app.js`. The `STADIUM_ZONES` picker uses 3-digit display numbers (101–234); users who know their real section numbers should use the **Manual Section Override** field instead.

## Settings and state

- `settings.json` — persisted settings. `sections` array is what the monitor actually watches. `customSections` string is the raw input from the Manual Override field in the UI; if non-empty, it overrides the visual picker.
- `state.json` — Playwright `storageState` (cookies + localStorage). Created after first successful login. Required for the seat map to load on the event page — without it, the page redirects to the homepage.
- Login URL is hardcoded to `https://auth.mhaifafc.com/` — there is no editable field for it.

## Important browser/Playwright notes

- Only `media` resource type is blocked (not images or fonts) — the seat map SVG requires images/fonts to render.
- Navigation uses `waitUntil: 'networkidle'` with a 45s timeout to ensure the seat map is fully loaded before scraping.
- `_runLoop()` is intentionally not awaited in `start()`. The monitor runs independently until `stop()` is called or `_stopRequested` is set.
- Always guard `this.page` before use — `stop()` sets it to null while the loop may still be mid-check.

## Key files (do NOT commit)

- `state.json` — saved Playwright browser session (cookies + localStorage)
- `.env` — credentials
- `settings.json` — saved dashboard settings (contains Telegram token + login credentials)

## Environment variables (`.env`)

These pre-fill the settings on first run:
- `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`
- `LOGIN_USERNAME`, `LOGIN_PASSWORD`
- `PORT` (default: 3000)
