# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this project is

A hosted ticket monitor for Maccabi Haifa FC (מכבי חיפה) games at Sami Ofer Stadium. It uses Playwright to scan the ticketing site and provides two interfaces: a Telegram button workflow for invited users with separate Maccabi sessions and monitors, plus the existing shared-login web dashboard.

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

Core dashboard files:

- **`server.js`** — Express HTTP server + WebSocket server. Serves the static frontend, exposes the dashboard REST API and token-protected `/bot-login` flow, forwards Monitor events to dashboard clients, and starts the Telegram services. Dashboard routes require a valid session cookie; see "Auth" below for the public login exceptions.

- **`monitor.js`** — `Monitor extends EventEmitter`. Manages the Playwright browser lifecycle (launch, login, monitoring loop). Emits: `log`, `status`, `sections`, `stats`, `alert`, `apiData` (raw JSON from intercepted XHR responses containing "availability", "SeatMap", "blocks", or "seats" in the URL). The `start()` method is async but `_runLoop()` runs detached (not awaited), so it doesn't block the HTTP response.

- **`public/`** — Static frontend (vanilla HTML/CSS/JS, no build step needed).
  - `index.html` — layout
  - `style.css` — dark theme dashboard styles
  - `app.js` — WebSocket client, renders sections grid, handles settings form, controls

Core Telegram files:

- **`bot/bot-server.js`** — wires the Telegram service, encrypted per-user session store, game discovery, and monitor coordinator into `server.js`.
- **`bot/telegram-bot-service.js`** — long polling, authorization, deep-link invitations, contextual inline-button menus, and per-user conversation state.
- **`bot/monitor-coordinator.js`** — owns one monitor per user, enforces `BOT_MAX_BROWSERS`, queues excess work, restores active monitors, and isolates session-expiry cleanup.
- **`bot/user-store.js`** — SQLite users, hash-only invite records, one-time login tokens, and persisted monitor configuration in `DATA_DIR/bot.db`.
- **`bot/user-session-store.js`** — AES-256-GCM encrypted Playwright storage state in one `DATA_DIR/session-<telegram-user-id>.enc` file per user.

## Data flow

```
Browser (dashboard)  ←──WebSocket──→  server.js  ←──events──  monitor.js
                     ←──REST API───→                         ──Playwright──→ mhaifafc.com
Telegram user        ←──Bot API────→  bot services ──────────┘
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
- `state.json` — legacy dashboard Playwright `storageState` (cookies + localStorage). It is not shared by Telegram users.
- `DATA_DIR/bot.db` — Telegram registrations, hashed invite records, one-time login tokens, and monitor configurations.
- `DATA_DIR/session-<telegram-user-id>.enc` — a separate encrypted Maccabi browser session for each Telegram user. Browser-login credentials are used for that login attempt only and are not persisted.
- Login URL is hardcoded to `https://auth.mhaifafc.com/` — there is no editable field for it.

## Auth

The web dashboard and Telegram bot have separate access models:

- The dashboard has one shared `APP_USERNAME` / `APP_PASSWORD` login. It is not a per-user web account system.
- Telegram administrators listed in `BOT_ADMIN_IDS` can create single-use, 24-hour deep links. Invited users register by opening the link; they never type the invite code into chat.
- Each Telegram user connects their own Maccabi account through a one-time browser-login link. Their encrypted session, selection state, and monitor lifecycle stay separate from other users.

- `APP_USERNAME` / `APP_PASSWORD` env vars gate dashboard access. Always set a non-empty `APP_PASSWORD` in the hosting environment; login is unavailable when it is unset.
- Session is an HMAC-signed cookie (`SESSION_SECRET` env var signs it), no server-side session store. Without `SESSION_SECRET` set, a random one is generated at boot, which invalidates all sessions on every restart/redeploy — set it explicitly in production.
- `GET /login.html`, `POST /api/login`, and the token-protected `GET`/`POST /bot-login` flow are reachable without a dashboard session; static dashboard files, all other `/api/*`, and the WebSocket upgrade are gated in `server.js`.
- Secret settings fields (`telegramToken`, `loginPassword`, `proxyPassword`) are never returned by `GET /api/settings` — the response only carries `<field>Set` booleans. The Settings form leaves those inputs blank and only sends a new value if the user retypes it; omitting it on save keeps whatever's already stored.
- "Send Test Message" hits `POST /api/telegram/test`, which reads the saved token server-side — the bot token never needs to reach the browser to test it.
- `ENCRYPTION_KEY` is required at startup. It encrypts Telegram users' Playwright sessions and also encrypts secret dashboard settings at rest.

## Telegram button workflow

```text
Admin /start → ➕ הזמן משתמש → copy deep link
Invited user opens link → 🔐 התחבר
Verified browser login → ⚽ בחר משחק
Game → sections → quantity → summary → ▶️ התחל מעקב
📊 סטטוס → ⏹ עצור or ⚙️ שנה בחירה
```

Buttons and legacy slash commands route through the same authorized actions. Registered-user arbitrary text only redisplays the contextual menu. Stale setup/change callbacks are state-checked so repeated old buttons cannot start a duplicate monitor or repeat a transition. When no games are available, the bot offers `🔄 בדוק שוב` and `🏠 תפריט ראשי`.

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
- `data/` — Telegram SQLite state and encrypted per-user browser sessions

## Environment variables (`.env`)

These pre-fill the legacy dashboard settings on first run:
- `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID` (the token also starts the Telegram bot; the chat ID is the fallback administrator ID)
- `LOGIN_USERNAME`, `LOGIN_PASSWORD`
- `PORT` (default: 3000)

Auth and hosting:
- `APP_USERNAME` (default: `admin`), `APP_PASSWORD` (required — no default, set this)
- `SESSION_SECRET` — signs session cookies; set this in production or every restart logs everyone out
- `ENCRYPTION_KEY` — required; encrypts secret settings and per-user Telegram browser sessions
- `DATA_DIR` — persistent directory for `settings.json`, `state.json`, `bot.db`, and encrypted per-user sessions
- `BASE_URL` — externally reachable origin used in one-time `/bot-login` links; it must match the deployed server origin

Telegram bot:
- `BOT_TOKEN` — optional alias that takes precedence over `TELEGRAM_TOKEN`
- `BOT_ADMIN_IDS` — comma-separated Telegram user IDs allowed to invite/list/revoke users; falls back to `TELEGRAM_CHAT_ID`
- `BOT_MAX_BROWSERS` — maximum concurrent per-user monitor browsers; additional monitors queue
