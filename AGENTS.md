# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this project is

A hosted web dashboard for monitoring ticket availability at Maccabi Haifa FC (מכבי חיפה) games at Sami Ofer Stadium. It uses Playwright to scan the ticketing site for available seats, and alerts via Telegram when tickets are found. Runs as a normal Node.js web app behind a login — no install or desktop app needed on the client side, just a browser.

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

- **`server.js`** — Express HTTP server + WebSocket server. Serves the static frontend, exposes REST API (`/api/settings`, `/api/monitor/start`, `/api/monitor/stop`, `/api/status`, `/api/telegram/test`, `/api/login`, `/api/logout`), and forwards Monitor events to all connected browser clients via WebSocket. Everything except `/login.html` and `/api/login` requires a valid session cookie — see "Auth" below.

- **`monitor.js`** — `Monitor extends EventEmitter`. Manages the Playwright browser lifecycle (launch, login, monitoring loop). Emits: `log`, `status`, `sections`, `stats`, `alert`, `apiData` (raw JSON from intercepted XHR responses containing "availability", "SeatMap", "blocks", or "seats" in the URL). The `start()` method is async but `_runLoop()` runs detached (not awaited), so it doesn't block the HTTP response.

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

The ticketing site (`tickets.mhaifafc.com`) renders a seat map SVG. Available sections appear as `li.collection-item` elements with an `onclick` attribute calling `stadium.processSectorById(sectorId)`. Their text content contains the Hebrew "גוש X" (Block X) where X is the visual section number.

**Key insight:** Sold-out sections are *absent* from this list — no element exists for them at all. So detection is: read which section numbers appear in the list → present = available, absent = unavailable.

**Two different IDs exist per section:**
- **Visual label** — the small integer shown on the map and in the element text (e.g. `13`, `14`, `15`). This is what users type in the Manual Section Override field.
- **Internal onclick ID** — a large integer used in `processSectorById()` (e.g. `1590`, `1591`, `1592`). This changes per event and is NOT the number to configure.

The monitor extracts both and compares against the visual label (primary), with onclick ID as a fallback:

```javascript
// In monitor.js _checkAvailability()
Array.from(document.querySelectorAll('[onclick*="processSectorById"]'))
  .map(el => {
    const m = (el.getAttribute('onclick') || '').match(/processSectorById\((\d+)\)/);
    if (!m) return null;
    const labelMatch = el.textContent.trim().match(/(\d+)/);
    return { id: m[1], label: labelMatch ? labelMatch[1] : m[1] };
  })
  .filter(Boolean);
```

The Live Log shows both: `Sections on page: [13 (id:1590), 14 (id:1591), 15 (id:1592)]`

**Section numbers** to configure are the small integers visible on the map (e.g. 13, 14, 15), NOT the large onclick IDs, and NOT the 3-digit numbers in the `STADIUM_ZONES` object in `app.js` (those are fake display numbers for the zone picker UI). Use the **Manual Section Override** field with the visual map numbers.

## Settings and state

- `settings.json` — persisted settings. Key fields:
  - `sections` — array of section IDs the monitor actually watches (small integers)
  - `customSections` — raw input from the Manual Override field; if non-empty, overrides the visual picker
  - `intervalMs` — polling interval in ms (default 10000)
  - `pauseOnHit` — stop monitoring automatically when tickets are found
  - `headful` — run Chromium in visible window mode
  - `proxyServer`, `proxyUsername`, `proxyPassword` — optional proxy
  - `autoPurchase` — attempt to auto-click section and confirm the quantity dialog when available
  - `desiredQuantity` — number of tickets to add to cart when auto-purchasing
- `state.json` — Playwright `storageState` (cookies + localStorage). Created after first successful login. Required for the seat map to load on the event page — without it, the page redirects to the homepage.
- Login URL is hardcoded to `https://auth.mhaifafc.com/` — there is no editable field for it.

## Auth

Single shared login for the whole site (not per-user accounts) — this monitors one Maccabi Haifa account for a small group of people sharing one dashboard.

- `APP_USERNAME` / `APP_PASSWORD` env vars gate access. Unset `APP_PASSWORD` = anyone can log in with a blank password — always set it in the hosting env.
- Session is an HMAC-signed cookie (`SESSION_SECRET` env var signs it), no server-side session store. Without `SESSION_SECRET` set, a random one is generated at boot, which invalidates all sessions on every restart/redeploy — set it explicitly in production.
- `GET /login.html` and `POST /api/login` are the only routes reachable without a session; everything else (static files, all other `/api/*`, the WebSocket upgrade) is gated in `server.js`.
- Secret settings fields (`telegramToken`, `loginPassword`, `proxyPassword`) are never returned by `GET /api/settings` — the response only carries `<field>Set` booleans. The Settings form leaves those inputs blank and only sends a new value if the user retypes it; omitting it on save keeps whatever's already stored.
- "Send Test Message" hits `POST /api/telegram/test`, which reads the saved token server-side — the bot token never needs to reach the browser to test it.
- If `ENCRYPTION_KEY` is set, secret fields are encrypted at rest in `settings.json` (AES-256-GCM). Without it they're stored in plaintext, same as before — this is defense for the file at rest, not what keeps the site private (the login gate does that).

## Queue-it handling

The monitor detects Queue-it overlays (`#queueit_overlay`, `[id*="queueit"]`, or `queue-it` in the URL) and sends a Telegram alert. It does not auto-skip the queue — detection is informational only.

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

Auth and hosting:
- `APP_USERNAME` (default: `admin`), `APP_PASSWORD` (required — no default, set this)
- `SESSION_SECRET` — signs session cookies; set this in production or every restart logs everyone out
- `ENCRYPTION_KEY` — optional, encrypts secret settings fields at rest in `settings.json`
- `DATA_DIR` — optional, redirects `settings.json`/`state.json` to a persistent volume/disk on the host instead of the app directory
