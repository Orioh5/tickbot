# Telegram Button Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let invited Telegram users complete registration, login, game/section/quantity selection, monitoring, and recovery by clicking contextual inline buttons instead of typing commands.

**Architecture:** Add a pure `BotMenu` renderer and route both callbacks and legacy slash commands through the same action methods in `TelegramBotService`. Extend invitation links with Telegram deep links, let the verified web-login route notify Telegram, and keep all authorization and state checks server-side. Persist only durable user/monitor state; keep short-lived keyboard state in memory and fail safely when it becomes stale.

**Tech Stack:** Node.js 24 CommonJS, Telegram Bot API long polling, Express, Playwright, `node:sqlite`, Node test runner; no new npm dependencies.

## Global Constraints

- Normal users must not need to type commands or free-form responses after clicking a valid invitation deep link.
- Bot interaction remains private-chat only and authorized by Telegram User ID.
- Quantity choices are exactly `1`, `2`, `3`, and `4`.
- Monitoring stores real section labels discovered from the event page, never fake dashboard section numbers.
- Credentials, login tokens, cookies, storage state, identity numbers, and owner identifiers must never appear in Telegram or logs.
- Login and invitation tokens remain single-use and are stored only as hashes.
- No payment action is automated.
- Use test-first red/green cycles and run the full suite after every task.

---

## File Map

- Create `bot/bot-menu.js` — pure menu/state rendering; no network or database access.
- Modify `bot/telegram-bot-service.js` — shared actions, callback routing, deep-link registration, contextual menu display.
- Modify `bot/bot-server.js` — fetch bot identity with `getMe`, wire login notifier, restore monitors.
- Modify `bot/user-store.js` — invitation expiry and atomic deep-link redemption.
- Modify `server.js` — notify Telegram after verified login without coupling Express to bot internals.
- Modify `bot/monitor-coordinator.js` — expose durable `queued`/`monitoring` status used by menus; prevent duplicate starts.
- Create `test/bot-menu.test.js` — pure menu-state matrix.
- Modify `test/telegram-bot-service.test.js` — deep links, callbacks, stale buttons, free text, admin menu.
- Modify `test/user-store.test.js` — invitation expiry and atomic redemption.
- Create `test/bot-login-route.test.js` — verified-login notification and failed-login behavior.

---

### Task 1: Pure Contextual Menu Renderer

**Files:**
- Create: `bot/bot-menu.js`
- Create: `test/bot-menu.test.js`

**Interfaces:**
- Consumes: `{ isAdmin, isRegistered, isRevoked, hasSession, monitorPhase }`.
- Produces: `BotMenu.main(state) -> { text: string, reply_markup: { inline_keyboard: Button[][] } }`.
- Produces callback names: `menu:login`, `menu:games`, `menu:status`, `menu:stop`, `menu:change`, `admin:invite`, `admin:users`.

- [ ] **Step 1: Write the failing state-matrix tests**

```js
// test/bot-menu.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BotMenu = require('../bot/bot-menu');

const callbacks = menu => menu.reply_markup.inline_keyboard.flat().map(button => button.callback_data);

test('unknown users receive no operational buttons', () => {
  const menu = BotMenu.main({ isRegistered: false, isRevoked: false });
  assert.deepEqual(callbacks(menu), []);
  assert.match(menu.text, /קישור הזמנה/);
});

test('registered user without session receives login only', () => {
  const menu = BotMenu.main({ isRegistered: true, isRevoked: false, hasSession: false });
  assert.deepEqual(callbacks(menu), ['menu:login']);
});

test('connected idle user receives games and status', () => {
  const menu = BotMenu.main({ isRegistered: true, hasSession: true, monitorPhase: null });
  assert.deepEqual(callbacks(menu), ['menu:games', 'menu:status']);
});

test('active user receives status stop and change', () => {
  const menu = BotMenu.main({ isRegistered: true, hasSession: true, monitorPhase: 'monitoring' });
  assert.deepEqual(callbacks(menu), ['menu:status', 'menu:stop', 'menu:change']);
});

test('administrator receives management actions', () => {
  const menu = BotMenu.main({ isRegistered: true, hasSession: true, isAdmin: true });
  assert.ok(callbacks(menu).includes('admin:invite'));
  assert.ok(callbacks(menu).includes('admin:users'));
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/bot-menu.test.js
```

Expected: FAIL with `Cannot find module '../bot/bot-menu'`.

- [ ] **Step 3: Implement the minimal pure renderer**

```js
// bot/bot-menu.js
'use strict';

const button = (text, callback_data) => ({ text, callback_data });

function main(state) {
  if (!state.isRegistered || state.isRevoked) {
    return { text: 'אין הרשאה. יש להיכנס דרך קישור הזמנה תקין.', reply_markup: { inline_keyboard: [] } };
  }

  const rows = [];
  if (!state.hasSession) rows.push([button('🔐 התחבר', 'menu:login')]);
  else if (state.monitorPhase === 'monitoring') {
    rows.push([button('📊 סטטוס', 'menu:status'), button('⏹ עצור', 'menu:stop')]);
    rows.push([button('⚙️ שנה בחירה', 'menu:change')]);
  } else if (state.monitorPhase === 'queued') {
    rows.push([button('📊 סטטוס', 'menu:status'), button('⏹ בטל', 'menu:stop')]);
  } else {
    rows.push([button('⚽ בחר משחק', 'menu:games'), button('📊 סטטוס', 'menu:status')]);
  }
  if (state.isAdmin) rows.push([button('➕ הזמן משתמש', 'admin:invite'), button('👥 משתמשים', 'admin:users')]);
  return { text: 'מה תרצה לעשות?', reply_markup: { inline_keyboard: rows } };
}

module.exports = { main };
```

- [ ] **Step 4: Verify GREEN and full regression**

```bash
node --test test/bot-menu.test.js
npm test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add bot/bot-menu.js test/bot-menu.test.js
git commit -m "feat: render contextual Telegram menus"
```

---

### Task 2: Telegram Deep-Link Invitations

**Files:**
- Modify: `bot/user-store.js`
- Modify: `bot/telegram-bot-service.js`
- Modify: `bot/bot-server.js`
- Modify: `test/user-store.test.js`
- Modify: `test/telegram-bot-service.test.js`

**Interfaces:**
- `UserStore.createInviteCode({ code, createdBy, expiresAt = now + 24 hours, now })` persists expiry.
- `UserStore.redeemInviteCode({ code, userId, username, now })` atomically marks the code used or throws.
- `TelegramBotService.setBotUsername(username)` stores the `getMe` username.
- `/start <code>` redeems and calls `showMainMenu(userId, chatId)`.

- [ ] **Step 1: Add failing invitation expiry and deep-link tests**

```js
test('expired invite cannot be redeemed', () => {
  const store = new UserStore();
  store.createInviteCode({ code: 'ABC', createdBy: '1', expiresAt: 100 });
  assert.throws(() => store.redeemInviteCode({ code: 'ABC', userId: '2', now: 101 }), /expired/i);
});

test('/start payload redeems invite without asking for text', async () => {
  store.createInviteCode({ code: 'ABC', createdBy: '1', expiresAt: Date.now() + 60_000 });
  await bot._dispatch(makeTextUpdate(2, '/start ABC'));
  assert.ok(store.getUser('2'));
  assert.equal(bot._getState('2').state, 'idle');
  assert.match(fetch.calls.at(-1).body.text, /התחבר/);
});

test('admin invite returns a Telegram deep link', async () => {
  bot.setBotUsername('MhfcTestBot');
  await bot._dispatch(makeCallbackUpdate(1, 'admin:invite'));
  assert.match(fetch.calls.at(-1).body.text, /https:\/\/t\.me\/MhfcTestBot\?start=/);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/user-store.test.js test/telegram-bot-service.test.js
```

Expected: FAIL because invitations have no expiry, `/start` ignores payloads, and no bot username exists.

- [ ] **Step 3: Add the schema migration and atomic redemption**

Add `expires_at INTEGER` to new databases and run a guarded migration for existing databases:

```js
const columns = this.db.prepare('PRAGMA table_info(invite_codes)').all();
if (!columns.some(column => column.name === 'expires_at')) {
  this.db.exec('ALTER TABLE invite_codes ADD COLUMN expires_at INTEGER');
}
```

Prepare an atomic redemption method using the transaction primitives supported by `node:sqlite`:

```js
this.db.exec('BEGIN IMMEDIATE');
try {
  const result = markInviteUsed.run(uid, code, now);
  if (result.changes !== 1) throw classifyInviteFailure(code, now);
  insertUser.run(uid, username, invite.created_by, now);
  this.db.exec('COMMIT');
} catch (error) {
  this.db.exec('ROLLBACK');
  throw error;
}
```

The conditional update must include `WHERE code = ? AND used_by IS NULL AND expires_at >= ?`. Keep a separate read only for producing a precise `invalid`, `expired`, or `already used` error; never use that read as the concurrency guard. Give newly created invitations a 24-hour expiry by default so existing callers remain valid.

- [ ] **Step 4: Resolve bot identity once at startup**

In `bot/bot-server.js`, after constructing the bot and before `bot.start()`:

```js
void bot.initialize().then(() => bot.start()).catch(error => {
  console.error('[TelegramBotService] initialization failed:', error.message);
});
```

Implement `initialize()` with `getMe`, validate `result.username`, and call `setBotUsername`.

- [ ] **Step 5: Route `/start <code>` and render the deep link**

Parse the payload with an exact command regex:

```js
const startMatch = text.match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]+))?$/);
```

For unknown users, accept only a valid payload. For known users, ignore the payload and show their current menu. `_cmdInvite` must return `https://t.me/${this.botUsername}?start=${code}`.

- [ ] **Step 6: Verify GREEN and regression**

```bash
node --test test/user-store.test.js test/telegram-bot-service.test.js
npm test
```

- [ ] **Step 7: Commit**

```bash
git add bot/user-store.js bot/telegram-bot-service.js bot/bot-server.js test/user-store.test.js test/telegram-bot-service.test.js
git commit -m "feat: register users through Telegram invite links"
```

---

### Task 3: Shared Menu Actions and Callback Authorization

**Files:**
- Modify: `bot/telegram-bot-service.js`
- Modify: `test/telegram-bot-service.test.js`

**Interfaces:**
- `showMainMenu(userId, chatId)` derives menu state and sends `BotMenu.main(...)`.
- `_runAction(action, { userId, chatId, fromUser })` is used by callbacks and legacy commands.
- Button callbacks never call command handlers independently.

- [ ] **Step 1: Write failing callback-routing tests**

```js
test('menu:login uses the same action as /login', async () => {
  await bot._dispatch(makeCallbackUpdate(7, 'menu:login'));
  assert.match(fetch.calls.at(-1).body.text, /http:\/\/localhost.*bot-login/);
});

test('menu:games discovers games for the clicking user', async () => {
  await bot._dispatch(makeCallbackUpdate(7, 'menu:games'));
  assert.equal(coordinator.discoverCalls[0], '7');
});

test('stale callback only redisplays current menu', async () => {
  await bot._dispatch(makeCallbackUpdate(7, 'menu:stop'));
  assert.equal(coordinator.stopCalls.length, 0);
  assert.match(fetch.calls.at(-1).body.text, /מה תרצה לעשות/);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/telegram-bot-service.test.js
```

- [ ] **Step 3: Implement shared action routing**

Use one action map:

```js
const ACTIONS = {
  'menu:login': 'login',
  'menu:games': 'games',
  'menu:status': 'status',
  'menu:stop': 'stop',
  'menu:change': 'change',
  'admin:invite': 'invite',
  'admin:users': 'users',
};
```

Before `_runAction`, require a private chat, a non-revoked user, and administrator status for `admin:*`. For `stop`, require runtime phase `queued` or `monitoring`; otherwise call `showMainMenu` without mutation.

Map legacy slash commands to the same action names instead of calling `_cmd*` directly. Free text for registered users calls `showMainMenu`.

- [ ] **Step 4: Verify GREEN and full regression**

```bash
node --test test/telegram-bot-service.test.js
npm test
```

- [ ] **Step 5: Commit**

```bash
git add bot/telegram-bot-service.js test/telegram-bot-service.test.js
git commit -m "feat: route Telegram menu buttons through shared actions"
```

---

### Task 4: Automatic Telegram Continuation After Web Login

**Files:**
- Modify: `bot/bot-server.js`
- Modify: `server.js`
- Create: `test/bot-login-route.test.js`

**Interfaces:**
- `botServices.loginNotifier.loginSucceeded(userId) -> Promise<void>`.
- Express calls the notifier only after authentication, token redemption, and encrypted session save all succeed.

- [ ] **Step 1: Extract an app factory and write failing route tests**

Make `server.js` export `createApp({ botServices })` without listening. `botServices` contains `maccabiAuthenticator`, `userSessionStore`, `secureLoginService`, and `loginNotifier`. Keep `startServer()` as the production entry path.

```js
test('verified login saves session then notifies Telegram', async () => {
  const calls = [];
  const app = createApp({
    botServices: {
      maccabiAuthenticator: { login: async () => ({ cookies: [{ name: 's', value: 'x' }], origins: [] }) },
      secureLoginService: { verifyToken: () => '42', redeemToken: () => '42' },
      userSessionStore: { save: async () => calls.push('save') },
      loginNotifier: { loginSucceeded: async id => calls.push(`notify:${id}`) },
    },
  });
  const response = await postForm(app, '/bot-login', { t: 'token', username: 'u', password: 'p' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, ['save', 'notify:42']);
});

test('failed login neither saves nor notifies', async () => {
  // authenticator.login throws; assert 401 and calls remains empty
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/bot-login-route.test.js
```

- [ ] **Step 3: Implement the narrow notifier**

In `bot/bot-server.js`, attach this object to the shared `botServices` container:

```js
botServices.loginNotifier = {
  loginSucceeded: userId => bot.sendMessage(userId, '✅ החשבון חובר בהצלחה.', {
    reply_markup: { inline_keyboard: [[
      { text: '⚽ בחר משחק', callback_data: 'menu:games' },
      { text: '🏠 תפריט ראשי', callback_data: 'menu:home' },
    ]] },
  }),
};
```

In `POST /bot-login`, execute in this exact order:

```js
const storageState = await authenticator.login(username, password);
const redeemedUserId = secureLoginService.redeemToken(rawToken);
await sessionStore.save(redeemedUserId, storageState);
await botServices.loginNotifier.loginSucceeded(redeemedUserId).catch(error => {
  console.error('[bot-login] Telegram notification failed:', error.message);
});
```

Telegram failure must not turn a successful website login into HTTP failure.

- [ ] **Step 4: Verify GREEN and regression**

```bash
node --test test/bot-login-route.test.js
npm test
```

- [ ] **Step 5: Commit**

```bash
git add server.js bot/bot-server.js test/bot-login-route.test.js
git commit -m "feat: continue Telegram flow after web login"
```

---

### Task 5: Confirmation-First Monitoring Setup

**Files:**
- Modify: `bot/telegram-bot-service.js`
- Modify: `test/telegram-bot-service.test.js`

**Interfaces:**
- New state: `AWAITING_CONFIRMATION` with `{ gameUrl, gameName, sections, quantity }`.
- Callbacks: `setup:confirm`, `setup:back`, `setup:cancel`, `games:retry`, `menu:home`.

- [ ] **Step 1: Write failing summary and confirmation tests**

```js
test('quantity selection shows summary without starting monitor', async () => {
  bot._setState('7', 'awaiting_quantity', { gameUrl: 'u', gameName: 'Game', sections: ['13'] });
  await bot._dispatch(makeCallbackUpdate(7, 'quantity:2'));
  assert.equal(coordinator.startCalls.length, 0);
  assert.match(fetch.calls.at(-1).body.text, /Game.*13.*2/s);
  assert.equal(bot._getState('7').state, 'awaiting_confirmation');
});

test('setup:confirm starts exactly one monitor', async () => {
  await bot._dispatch(makeCallbackUpdate(7, 'setup:confirm'));
  await bot._dispatch(makeCallbackUpdate(7, 'setup:confirm'));
  assert.equal(coordinator.startCalls.length, 1);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/telegram-bot-service.test.js
```

- [ ] **Step 3: Implement confirmation callbacks**

Replace the current immediate `_startConfiguredMonitor` call from `quantity:*` with a summary keyboard. On `setup:confirm`, clear the state before awaiting `startMonitor`; this makes a double click stale. Persist configuration only as part of the confirmed action.

For no games, send:

```js
{
  text: 'לא נמצאו משחקים זמינים כרגע.',
  reply_markup: { inline_keyboard: [[
    { text: '🔄 בדוק שוב', callback_data: 'games:retry' },
    { text: '🏠 תפריט ראשי', callback_data: 'menu:home' },
  ]] },
}
```

- [ ] **Step 4: Verify GREEN and regression**

```bash
node --test test/telegram-bot-service.test.js
npm test
```

- [ ] **Step 5: Commit**

```bash
git add bot/telegram-bot-service.js test/telegram-bot-service.test.js
git commit -m "feat: confirm Telegram monitoring setup"
```

---

### Task 6: Session Expiry, Change Selection, and Lifecycle Menus

**Files:**
- Modify: `bot/game-discovery.js`
- Modify: `bot/monitor-coordinator.js`
- Modify: `bot/telegram-bot-service.js`
- Modify: `test/game-discovery.test.js`
- Modify: `test/monitor-coordinator.test.js`
- Modify: `test/telegram-bot-service.test.js`

**Interfaces:**
- Errors that prove authentication loss carry `code = 'SESSION_EXPIRED'`.
- Coordinator emits or calls `onSessionExpired(userId)` after stopping only that user's monitor.
- `menu:change` requires confirmation callback `change:confirm` before stopping active work.

- [ ] **Step 1: Write failing session-expiry and change-confirmation tests**

```js
test('redirect to login is reported as SESSION_EXPIRED', async () => {
  page.url = () => 'https://auth.mhaifafc.com/login';
  await assert.rejects(
    () => service.discoverGames('42'),
    error => error.code === 'SESSION_EXPIRED'
  );
});

test('session expiry stops only the affected user and offers reconnect', async () => {
  await coordinator.handleSessionExpired('1');
  assert.equal(coordinator.getStatus('1'), null);
  assert.equal(coordinator.getStatus('2').phase, 'monitoring');
  assert.equal(sessionStore.has('1'), false);
});

test('change selection requires confirmation before stopping', async () => {
  await bot._dispatch(makeCallbackUpdate(7, 'menu:change'));
  assert.equal(coordinator.stopCalls.length, 0);
  await bot._dispatch(makeCallbackUpdate(7, 'change:confirm'));
  assert.deepEqual(coordinator.stopCalls, ['7']);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/game-discovery.test.js test/monitor-coordinator.test.js test/telegram-bot-service.test.js
```

- [ ] **Step 3: Implement explicit expiry and lifecycle transitions**

After each authenticated navigation, detect `auth.mhaifafc.com/login` or the visible login form. Throw:

```js
const error = new Error('Saved session expired');
error.code = 'SESSION_EXPIRED';
throw error;
```

Coordinator expiry handling must stop/remove only the target user's monitor, set `active = false`, delete the encrypted session, clear queued work for the user, and send `🔐 התחבר מחדש`.

`menu:change` shows confirmation buttons; `change:confirm` stops/removes current work and calls the games action; `change:cancel` calls `showMainMenu`.

- [ ] **Step 4: Verify GREEN and regression**

```bash
node --test test/game-discovery.test.js test/monitor-coordinator.test.js test/telegram-bot-service.test.js
npm test
```

- [ ] **Step 5: Commit**

```bash
git add bot/game-discovery.js bot/monitor-coordinator.js bot/telegram-bot-service.js test/game-discovery.test.js test/monitor-coordinator.test.js test/telegram-bot-service.test.js
git commit -m "feat: recover Telegram flow from session expiry"
```

---

### Task 7: Final Integration, Documentation, and Smoke Test

**Files:**
- Modify: `.env.example`
- Modify: `TESTING.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Test: all `test/*.test.js`

**Interfaces:**
- No new runtime interfaces; this task verifies and documents the completed flow.

- [ ] **Step 1: Add operational documentation**

Document these environment variables without real values:

```env
TELEGRAM_TOKEN=
TELEGRAM_CHAT_ID=
BOT_ADMIN_IDS=
BOT_MAX_BROWSERS=2
SESSION_SECRET=
ENCRYPTION_KEY=
BASE_URL=http://localhost:3001
DATA_DIR=./data
```

Document the user smoke path exactly:

```text
Admin /start → ➕ הזמן משתמש → copy deep link
Invited user opens link → 🔐 התחבר
Verified browser login → ⚽ בחר משחק
Game → sections → quantity → summary → ▶️ התחל מעקב
📊 סטטוס → ⏹ עצור or ⚙️ שנה בחירה
```

- [ ] **Step 2: Run static and full automated verification**

```bash
git diff --check
node -c server.js
for f in bot/*.js; do node -c "$f"; done
node --test --test-reporter=spec
```

Expected: zero syntax errors, zero whitespace errors, all tests PASS.

- [ ] **Step 3: Run local Telegram smoke test**

```bash
npm start
```

Verify manually without exposing secrets:

1. Existing admin presses `➕ הזמן משתמש`.
2. Open the resulting deep link from a second Telegram account.
3. Confirm no invite code must be typed.
4. Press `🔐 התחבר`, complete web login, and confirm Telegram automatically shows `⚽ בחר משחק`.
5. With no active event, confirm `🔄 בדוק שוב` and `🏠 תפריט ראשי` appear.
6. Send arbitrary text and confirm it only redisplays the contextual menu.
7. Press an old button twice and confirm no duplicate monitor or state transition occurs.

- [ ] **Step 4: Review secret hygiene**

```bash
git status --short
git ls-files .env data state.json settings.json
rg -n "TELEGRAM_TOKEN=.+|APP_PASSWORD=.+|SESSION_SECRET=.+|ENCRYPTION_KEY=.+" --glob '!node_modules/**' --glob '!.env'
```

Expected: `.env`, `data/`, `state.json`, and `settings.json` are not tracked; no real secret appears in tracked files.

- [ ] **Step 5: Commit**

```bash
git add .env.example TESTING.md AGENTS.md CLAUDE.md
git commit -m "docs: document Telegram button workflow"
```

- [ ] **Step 6: Final verification after all commits**

```bash
git status --short
set -o pipefail
node --test --test-reporter=tap | tail -12
```

Expected: only intentional local runtime artifacts remain untracked; test summary reports zero failures.
