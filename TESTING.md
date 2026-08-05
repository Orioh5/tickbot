# Testing

## Automated verification

Run the complete test suite:

```bash
npm test
```

Run it with Node's built-in coverage report:

```bash
npm run test:coverage
```

Before a release or deployment, run the complete static and automated verification:

```bash
git diff --check
node -c server.js
for f in bot/*.js; do node -c "$f"; done
node --test --test-reporter=spec
```

The tests use Node's built-in test runner, temporary data directories, and mocked browser/API boundaries. They never use the production `settings.json`, encrypted user sessions, Telegram API, or ticketing site.

Current automated coverage includes:

- contextual Telegram menus and button/command routing;
- private-chat, invited-user, administrator, and stale-callback authorization;
- single-use deep-link invitations and automatic continuation after browser login;
- game, section, quantity, confirmation, status, stop, and change-selection flows;
- per-user encrypted sessions, concurrent monitor limits, queueing, and session-expiry recovery;
- section label and internal ID parsing;
- dynamic event-ID extraction and sectors-info API parsing;
- API-first polling, ID mapping, and one-time DOM fallback;
- seat-map load failures and availability transitions;
- Queue-it notification deduplication;
- browser refresh, startup failure, and cleanup behavior;
- settings validation, secret preservation, redaction, and encryption.

## Local startup smoke

To check the HTTP server without starting Telegram polling, use an isolated temporary `DATA_DIR`. In a clean shell, export non-production values for `ENCRYPTION_KEY`, `APP_PASSWORD`, and `SESSION_SECRET`, and export both `TELEGRAM_TOKEN` and `BOT_TOKEN` as empty strings. Do not source production environment values or point this check at production data.

```bash
DATA_DIR=/tmp/mhfc-local-smoke PORT=3001 BASE_URL=http://localhost:3001 npm start
```

Confirm `GET /login.html` returns the dashboard login page and an unauthenticated `GET /api/status` returns `401`, then stop the process. This check is local only and does not validate Telegram buttons or the live ticketing site.

## Telegram button smoke

Use an existing administrator and a real second Telegram account. Do not fabricate an identity, paste invite codes into chat, expose a deep link in logs, or run a second process with the same bot token while the production bot is polling.

The expected user path is:

```text
Admin /start → ➕ הזמן משתמש → copy deep link
Invited user opens link → 🔐 התחבר
Verified browser login → ⚽ בחר משחק
Game → sections → quantity → summary → ▶️ התחל מעקב
📊 סטטוס → ⏹ עצור or ⚙️ שנה בחירה
```

Manual checks:

1. The existing administrator presses `➕ הזמן משתמש` and privately copies the returned one-use deep link.
2. The invited user opens that link from a second Telegram account and confirms that no invite code must be typed.
3. The invited user presses `🔐 התחבר`, completes the browser login, and confirms Telegram automatically shows `⚽ בחר משחק`.
4. With no active event, confirm `🔄 בדוק שוב` and `🏠 תפריט ראשי` appear.
5. Send arbitrary text and confirm it only redisplays the contextual menu.
6. Complete game, sections, quantity, and summary selection, then press `▶️ התחל מעקב`.
7. Press `📊 סטטוס`, then verify `⏹ עצור` and the confirmation-gated `⚙️ שנה בחירה` flow.
8. Press an old button twice and confirm no duplicate monitor or state transition occurs.

This live smoke requires external Telegram and Maccabi interactions. Record any step not personally performed as remaining manual verification; automated coverage is not a substitute for claiming those button presses occurred.

## Telegram owner assignment

Before a supervised live availability test, use a non-production event/cart, set `desiredQuantity=1`, confirm the Telegram recipient belongs to the operator, and stop at the cart link. Never enter payment data or press the final payment button during verification.

The next useful automated layer is a small Playwright end-to-end fixture using saved local HTML. That would cover selectors, the settings UI, and auto-purchase interaction without accessing the live ticketing site.
