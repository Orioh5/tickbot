# Personal Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Telegram-registered user an administrator-managed website login and a personal dashboard that controls the same saved selection and monitor as Telegram.

**Architecture:** Extend `UserStore` with web credentials and keep `bot.db` authoritative. Add focused web-auth and dashboard service modules, inject the existing bot domain services into Express, and expose role-scoped REST/WebSocket interfaces. Replace the shared dashboard shell with role-specific administrator and personal pages while retaining the existing Telegram monitor, queue, login-link, notification, and owner-assignment behavior.

**Tech Stack:** Node.js 24 CommonJS, `node:sqlite`, `node:crypto` scrypt, Express 4, `ws`, vanilla HTML/CSS/JavaScript, Node test runner.

## Global Constraints

- Only users who completed Telegram invitation registration are eligible for web credentials.
- `DATA_DIR/bot.db` is the sole source of truth for users and monitoring configuration.
- Website and Telegram actions address one shared configuration and one `MonitorCoordinator` entry.
- Plaintext passwords, password hashes, Maccabi cookies, Playwright storage state, bot tokens, and encryption keys are never returned to browsers.
- Personal APIs derive the Telegram user ID exclusively from the authenticated server session.
- Payment remains manual; the existing Telegram owner-assignment flow remains unchanged.
- The frontend remains build-free vanilla HTML, CSS, and JavaScript and supports Hebrew RTL presentation.
- Preserve unrelated local changes in `.github/workflows/test.yml`, `bot/game-discovery.js`, `test/game-discovery.test.js`, and local configuration files.

---

## File Structure

- `bot/user-store.js` — schema migration and authoritative web credential/access fields.
- `web/passwords.js` — password normalization, scrypt hashing, and verification only.
- `web/session-manager.js` — signed role-aware cookies and session verification only.
- `web/login-limiter.js` — bounded in-memory login attempt tracking only.
- `web/dashboard-service.js` — user-scoped/admin-scoped orchestration over existing bot services.
- `server.js` — HTTP/WS adapters, dependency injection, and route authorization.
- `bot/bot-server.js` — expose initialized shared services to the web adapters.
- `bot/monitor-coordinator.js` — emit user-scoped lifecycle events and queue position snapshots.
- `public/login.html`, `public/login.js` — role-neutral login entry point.
- `public/dashboard.html`, `public/dashboard.js`, `public/dashboard.css` — personal workflow.
- `public/admin.html`, `public/admin.js`, `public/admin.css` — administrator user management.
- `test/web-*.test.js` — focused unit and route tests.
- `TESTING.md` — local personal-dashboard smoke procedure.

### Task 1: Persist administrator-managed web credentials

**Files:**
- Create: `web/passwords.js`
- Modify: `bot/user-store.js`
- Test: `test/web-credentials.test.js`
- Test: `test/user-store.test.js`

**Interfaces:**
- Produces: `normalizeWebUsername(value): string`, `hashPassword(password): Promise<string>`, `verifyPassword(password, encoded): Promise<boolean>`.
- Produces: `UserStore.setWebCredentials(userId, { username, passwordHash, now }): object`, `setWebAccess(userId, enabled): void`, `findWebUser(username): object|null`, `recordWebLogin(userId, now): void`, `listWebUsers(): object[]`.

- [ ] **Step 1: Write failing password tests**

```js
test('password hashes are salted and verifiable without retaining plaintext', async () => {
  const a = await hashPassword('correct horse battery staple');
  const b = await hashPassword('correct horse battery staple');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse battery staple', a), true);
  assert.equal(await verifyPassword('wrong password', a), false);
  assert.equal(a.includes('correct horse'), false);
});

test('web usernames normalize consistently', () => {
  assert.equal(normalizeWebUsername('  OrI.OH  '), 'ori.oh');
  assert.throws(() => normalizeWebUsername(''), /username/i);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test test/web-credentials.test.js`
Expected: FAIL because `web/passwords.js` does not exist.

- [ ] **Step 3: Implement scrypt encoding and constant-time verification**

```js
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

function normalizeWebUsername(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(normalized)) throw new Error('Invalid web username');
  return normalized;
}

async function hashPassword(password) {
  if (String(password).length < 10) throw new Error('Password must contain at least 10 characters');
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}
```

Implement `verifyPassword` by decoding the two Base64 fields, deriving 64 bytes, rejecting malformed encodings, and calling `crypto.timingSafeEqual` only for equal-length buffers.

- [ ] **Step 4: Add failing store migration and credential tests**

```js
test('assigns unique web credentials only to an active Telegram user', () => {
  const store = makeStore();
  store.createUser({ telegramUserId: '42', username: 'Telegram Name' });
  const row = store.setWebCredentials('42', {
    username: 'site-user', passwordHash: 'scrypt$salt$hash', now: 100,
  });
  assert.equal(row.web_username, 'site-user');
  assert.equal(store.findWebUser('SITE-USER').telegram_user_id, '42');
  assert.throws(() => store.setWebCredentials('404', {
    username: 'other-user', passwordHash: 'x', now: 100,
  }), /registered Telegram user/i);
});
```

Also assert uniqueness, disabled access, revoked-user rejection, last-login recording, redacted `listWebUsers()`, and migration of an existing file-backed database.

- [ ] **Step 5: Add nullable columns and transactional store methods**

Add `web_username TEXT`, `web_password_hash TEXT`, `web_access_enabled INTEGER NOT NULL DEFAULT 0`, `web_credentials_updated_at INTEGER`, and `web_last_login_at INTEGER` using `PRAGMA table_info(users)` guards inside the existing migration transaction. Add a unique partial index on non-null `web_username`. `listWebUsers()` must select an explicit safe projection and return `web_credentials_set` instead of the hash.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/web-credentials.test.js test/user-store.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/passwords.js bot/user-store.js test/web-credentials.test.js test/user-store.test.js
git commit -m "feat: add web credentials to registered users"
```

### Task 2: Add role-aware sessions and login throttling

**Files:**
- Create: `web/session-manager.js`
- Create: `web/login-limiter.js`
- Test: `test/web-session-manager.test.js`
- Test: `test/web-login-limiter.test.js`

**Interfaces:**
- Produces: `new SessionManager({ secret, maxAgeMs, secure, now })`, `.create({ role, userId? }): string`, `.verify(token): { role: 'admin'|'user', userId?: string }|null`, `.cookieHeader(identity): string`, `.clearCookieHeader(): string`.
- Produces: `new LoginLimiter({ maxAttempts, windowMs, now })`, `.check({ username, ip }): boolean`, `.recordFailure({ username, ip }): void`, `.reset({ username, ip }): void`.

- [ ] **Step 1: Write failing session tests**

```js
test('session round-trips a user identity and rejects tampering and expiry', () => {
  let now = 1_000;
  const sessions = new SessionManager({ secret: 'x'.repeat(32), maxAgeMs: 500, now: () => now });
  const token = sessions.create({ role: 'user', userId: '42' });
  assert.deepEqual(sessions.verify(token), { role: 'user', userId: '42' });
  assert.equal(sessions.verify(`${token}x`), null);
  now = 1_501;
  assert.equal(sessions.verify(token), null);
});
```

Assert role validation and cookie attributes for development and production.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/web-session-manager.test.js test/web-login-limiter.test.js`
Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement compact signed sessions**

Encode `{ role, userId, exp }` as Base64url JSON and append an HMAC-SHA256 Base64url signature. Verify shape, signature with `timingSafeEqual`, expiration, role, and required `userId` for user sessions. Use cookie name `mhfc_session`.

- [ ] **Step 4: Implement bounded login throttling**

Use separate keys `u:<normalized username>` and `ip:<ip>`. `check` returns false when either key has reached five failures within 15 minutes. `recordFailure` prunes expired entries and caps the map at 10,000 keys by deleting the oldest entry. `reset` removes both keys after a successful login.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/web-session-manager.test.js test/web-login-limiter.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/session-manager.js web/login-limiter.js test/web-session-manager.test.js test/web-login-limiter.test.js
git commit -m "feat: add secure web sessions and login throttling"
```

### Task 3: Expose shared bot services and observable monitor state

**Files:**
- Modify: `bot/bot-server.js`
- Modify: `bot/monitor-coordinator.js`
- Test: `test/bot-server.test.js`
- Test: `test/monitor-coordinator.test.js`

**Interfaces:**
- Produces on `botServices`: `userStore`, `monitorCoordinator`, `gameDiscovery`, and existing login/session services.
- Produces: `MonitorCoordinator extends EventEmitter`, emitting `userStatus` with `{ userId, status }`.
- Produces: `getUserSnapshot(userId): { status: object|null, queuePosition: number|null, config: object|null }`.

- [ ] **Step 1: Write failing service exposure and event tests**

```js
test('coordinator publishes a scoped queued snapshot', async () => {
  const coordinator = makeCoordinator({ maxConcurrent: 0 });
  const events = [];
  coordinator.on('userStatus', event => events.push(event));
  await coordinator.startMonitor('42', {
    gameUrl: 'https://tickets/event?eventId=1', sections: ['13'], quantity: 1, chatId: '42',
  });
  assert.deepEqual(coordinator.getUserSnapshot('42'), {
    status: { running: false, busy: true, phase: 'queued' },
    queuePosition: 1,
    config: assert.matching({ game_url: 'https://tickets/event?eventId=1' }),
  });
  assert.equal(events.at(-1).userId, '42');
});
```

Add assertions for started, stopped, promoted, session-expired, and naturally completed monitors.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test test/bot-server.test.js test/monitor-coordinator.test.js`
Expected: FAIL because the coordinator is not an `EventEmitter` and services are not exposed.

- [ ] **Step 3: Implement service exposure**

In `bot-server.js`, assign the initialized instances before operational startup:

```js
botServices.userStore = userStore;
botServices.monitorCoordinator = monitorCoordinator;
botServices.gameDiscovery = gameDiscovery;
```

Extend the bootstrap `botServices` shape in `server.js` in the server task, not here.

- [ ] **Step 4: Implement scoped coordinator events and snapshot**

Make `MonitorCoordinator` extend `EventEmitter`, call `super()`, centralize emission in `_emitUserStatus(userId)`, and invoke it after each queue/monitor transition. `getUserSnapshot` reads `getStatus`, a 1-based queue position, and `userStore.getMonitoringConfig` without exposing storage state.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/bot-server.test.js test/monitor-coordinator.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bot/bot-server.js bot/monitor-coordinator.js test/bot-server.test.js test/monitor-coordinator.test.js
git commit -m "feat: expose shared monitor state to web clients"
```

### Task 4: Add the user-scoped dashboard service

**Files:**
- Create: `web/dashboard-service.js`
- Test: `test/web-dashboard-service.test.js`

**Interfaces:**
- Consumes: `userStore`, `userSessionStore`, `secureLoginService`, `monitorCoordinator`.
- Produces: `getPersonalSnapshot(userId)`, `discoverGames(userId)`, `discoverSections(userId, gameUrl)`, `saveSelection(userId, input)`, `start(userId)`, `stop(userId)`, `createMaccabiLoginLink(userId)`, `listAdminUsers()`, `setCredentials(userId, input)`, `setWebAccess(userId, enabled)`, `adminStop(userId)`.

- [ ] **Step 1: Write failing isolation and orchestration tests**

```js
test('start uses the authenticated user saved selection and Telegram chat id', async () => {
  const calls = [];
  const service = makeService({
    config: { game_url: 'https://tickets/event?eventId=7', sections: ['13'], quantity: 2 },
    startMonitor: async (...args) => calls.push(args),
  });
  await service.start('42');
  assert.deepEqual(calls, [['42', {
    gameUrl: 'https://tickets/event?eventId=7', sections: ['13'], quantity: 2, chatId: '42',
  }]]);
});
```

Test missing/revoked users, missing session/config, malformed game URLs, duplicate sections, quantity outside `1..10`, safe admin projections, credential assignment, access disabling, and emergency stop.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/web-dashboard-service.test.js`
Expected: FAIL because the service module is absent.

- [ ] **Step 3: Implement explicit validators and orchestration**

`saveSelection` accepts `{ gameUrl, gameName, sections, quantity }`, requires an HTTPS `tickets.mhaifafc.com` URL, 1–100 unique numeric section labels, and integer quantity `1..10`, then calls `userStore.setMonitoringConfig`. `getPersonalSnapshot` returns only identity display data, `maccabiConnected`, saved selection, coordinator status/queue position, and no secrets.

Credential assignment hashes the password before calling `setWebCredentials`. Disabling web access does not revoke Telegram but prevents subsequent web authorization. `createMaccabiLoginLink` delegates to the existing one-time secure login service.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/web-dashboard-service.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/dashboard-service.js test/web-dashboard-service.test.js
git commit -m "feat: add personal dashboard domain service"
```

### Task 5: Replace shared authentication with role-scoped HTTP APIs

**Files:**
- Modify: `server.js`
- Modify: `public/login.html`
- Create: `public/login.js`
- Test: `test/web-auth-routes.test.js`
- Test: `test/web-dashboard-routes.test.js`
- Modify: `test/bot-login-route.test.js`

**Interfaces:**
- Produces routes: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
- Produces personal routes under `/api/dashboard/*` and admin routes under `/api/admin/*`.
- Consumes `SessionManager`, `LoginLimiter`, `verifyPassword`, and `DashboardService`.

- [ ] **Step 1: Write failing authentication route tests**

```js
test('personal login sets a user session and redirects by role', async () => {
  const response = await request(app, 'POST', '/api/auth/login', {
    username: 'site-user', password: 'correct password',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, role: 'user', destination: '/dashboard.html' });
  assert.match(response.headers['set-cookie'][0], /mhfc_session=.*HttpOnly.*SameSite=Lax/);
});
```

Test bootstrap admin login, generic 401 errors, 429 throttling, logout, disabled/revoked rejection on `/api/auth/me`, and public access limited to login/bot-login/health assets.

- [ ] **Step 2: Write failing dashboard/admin route tests**

Assert that personal requests never accept a body/query `userId`, user A cannot read user B, admin-only routes return 403 for personal users, validation errors return 400, monitor conflicts return 409, session expiry returns a stable reconnect response, and internal failures return safe 500 responses.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `node --test test/web-auth-routes.test.js test/web-dashboard-routes.test.js test/bot-login-route.test.js`
Expected: FAIL because the role-scoped routes do not exist.

- [ ] **Step 4: Inject initialized services without weakening startup ordering**

Extend `botServices` with nullable `userStore`, `monitorCoordinator`, and `gameDiscovery`. Construct `DashboardService` lazily per request or after bot initialization; return 503 while required services are unavailable. Accept explicit injected doubles in `createApp` for tests.

- [ ] **Step 5: Implement authorization middleware and routes**

Add `requireIdentity`, `requireUser`, and `requireAdmin`. `requireIdentity` verifies the cookie and re-loads the user for every personal request, rejecting revoked, disabled, or credentialless accounts. Map domain errors through one safe response helper.

Personal endpoints:

```text
GET  /api/dashboard/snapshot
POST /api/dashboard/maccabi-link
GET  /api/dashboard/games
POST /api/dashboard/sections
PUT  /api/dashboard/selection
POST /api/dashboard/monitor/start
POST /api/dashboard/monitor/stop
```

Administrator endpoints:

```text
GET  /api/admin/users
PUT  /api/admin/users/:userId/credentials
PUT  /api/admin/users/:userId/access
POST /api/admin/users/:userId/monitor/stop
```

- [ ] **Step 6: Replace inline login script with `login.js`**

Submit credentials to `/api/auth/login`, display the server's generic error in Hebrew, and navigate only to the server-provided `destination`.

- [ ] **Step 7: Run focused route tests**

Run: `node --test test/web-auth-routes.test.js test/web-dashboard-routes.test.js test/bot-login-route.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server.js public/login.html public/login.js test/web-auth-routes.test.js test/web-dashboard-routes.test.js test/bot-login-route.test.js
git commit -m "feat: add role-scoped dashboard APIs"
```

### Task 6: Add authenticated user-scoped WebSocket updates

**Files:**
- Modify: `server.js`
- Test: `test/web-dashboard-websocket.test.js`

**Interfaces:**
- Consumes: session identity and `MonitorCoordinator` `userStatus` events.
- Produces messages: `{ type: 'snapshot', snapshot }`, `{ type: 'monitor', status, queuePosition }`, `{ type: 'selection', selection }`, `{ type: 'access-revoked' }`.

- [ ] **Step 1: Write failing WebSocket isolation tests**

Open authenticated sockets for users `42` and `84`, emit `userStatus` for `42`, and assert only `42` receives it. Assert an admin socket can receive a redacted aggregate refresh, unauthenticated upgrades fail, and disabled users receive `access-revoked` before closure.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/web-dashboard-websocket.test.js`
Expected: FAIL because the current WebSocket broadcasts one shared monitor to every client.

- [ ] **Step 3: Store verified identity on each connection**

During upgrade, verify `mhfc_session`, re-check the user record, and attach `{ role, userId }` to the accepted connection. On connection, send a complete current snapshot before incremental events.

- [ ] **Step 4: Replace global personal broadcasts with scoped delivery**

Route coordinator events by exact string user ID. Publish a fresh selection message after either interface persists configuration; if a shared event bus is needed, use a small process-local `EventEmitter` owned by the server adapter. Re-fetch the complete snapshot on client reconnect.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/web-dashboard-websocket.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server.js test/web-dashboard-websocket.test.js
git commit -m "feat: scope dashboard realtime updates by user"
```

### Task 7: Build the administrator panel

**Files:**
- Create: `public/admin.html`
- Create: `public/admin.js`
- Create: `public/admin.css`
- Test: `test/admin-ui.test.js`

**Interfaces:**
- Consumes: `/api/auth/me`, `/api/admin/users`, and administrator mutation routes.
- Produces: accessible Hebrew RTL user table/cards and credential/access dialogs.

- [ ] **Step 1: Write failing static UI contract tests**

Parse the HTML as text and assert `lang="he"`, `dir="rtl"`, labeled username/password inputs, logout control, user list container, modal `role="dialog"`, live status region, and no secret field that displays an existing password/hash/session.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/admin-ui.test.js`
Expected: FAIL because admin assets do not exist.

- [ ] **Step 3: Implement the admin shell and responsive styling**

Render cards on narrow screens and a table on wide screens. Show Telegram identity, Maccabi connection, credential/access state, monitor phase, and last login. Add explicit loading, empty, error, and success states.

- [ ] **Step 4: Implement safe administrator actions**

Credential modal submits a new username and password but never pre-fills a password. Access toggle requires confirmation when disabling. Emergency monitor stop requires confirmation. On 401 navigate to `/login.html`; on 403 show a Hebrew authorization error.

- [ ] **Step 5: Run UI contract tests**

Run: `node --test test/admin-ui.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/admin.html public/admin.js public/admin.css test/admin-ui.test.js
git commit -m "feat: add web user administration panel"
```

### Task 8: Build the personal synchronized dashboard

**Files:**
- Create: `public/dashboard.html`
- Create: `public/dashboard.js`
- Create: `public/dashboard.css`
- Test: `test/personal-dashboard-ui.test.js`

**Interfaces:**
- Consumes: personal REST routes and scoped WebSocket messages.
- Produces: state-driven Hebrew RTL Maccabi login, game, section, quantity, review, and monitor views.

- [ ] **Step 1: Write failing UI contract tests**

Assert accessible fieldsets/buttons for all six workflow states, a logout action, connection and queue status regions with `aria-live`, reconnect banner, retry actions, and no editable Telegram user ID or event URL fields.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/personal-dashboard-ui.test.js`
Expected: FAIL because personal dashboard assets do not exist.

- [ ] **Step 3: Implement one authoritative client state model**

Use:

```js
const state = {
  identity: null,
  maccabiConnected: false,
  games: [],
  sections: [],
  selection: null,
  monitor: null,
  queuePosition: null,
  connected: false,
  pendingAction: null,
  error: null,
};
```

All rendering derives from this object. Fetch `/api/dashboard/snapshot` before opening the socket, and fetch it again after reconnect before applying later messages.

- [ ] **Step 4: Implement the shared Telegram-equivalent workflow**

Missing Maccabi session shows the one-time login-link action. Game selection calls discovery; game choice loads real sections; section and quantity selection lead to review; start uses the saved server selection; active/queued states expose stop and confirmation-gated change selection. Disable repeated actions while requests are pending.

- [ ] **Step 5: Implement failure and synchronization states**

Show explicit states for no games, expired session, queued monitor, start conflict, discovery failure, disconnected socket, access loss, owner selection, and cart ready. A server selection/monitor event replaces the matching local state rather than merging stale form values.

- [ ] **Step 6: Run UI contract tests**

Run: `node --test test/personal-dashboard-ui.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add public/dashboard.html public/dashboard.js public/dashboard.css test/personal-dashboard-ui.test.js
git commit -m "feat: add synchronized personal dashboard"
```

### Task 9: Regression, security, and local smoke verification

**Files:**
- Modify: `TESTING.md`
- Modify as required by failures: files from Tasks 1–8 only

**Interfaces:**
- Consumes all completed personal dashboard interfaces.
- Produces documented repeatable verification with no production data or live payment actions.

- [ ] **Step 1: Run syntax and whitespace checks**

Run:

```bash
git diff --check
node -c server.js
for f in bot/*.js web/*.js public/*.js; do node -c "$f"; done
```

Expected: all commands exit 0.

- [ ] **Step 2: Run focused web and shared-service tests**

Run:

```bash
node --test test/web-*.test.js test/admin-ui.test.js test/personal-dashboard-ui.test.js test/user-store.test.js test/monitor-coordinator.test.js test/telegram-bot-service.test.js
```

Expected: PASS with zero failed tests.

- [ ] **Step 3: Run the complete regression suite**

Run: `npm test`
Expected: PASS with zero failed tests.

- [ ] **Step 4: Add the isolated local smoke procedure**

Document creating a temporary `DATA_DIR`, non-production `ENCRYPTION_KEY`, `SESSION_SECRET`, and `APP_PASSWORD`, with Telegram tokens empty. Document fixture-user creation through `UserStore`, admin credential assignment, personal login, isolation checks, and mocked start/stop boundaries. Explicitly state that the smoke does not contact Telegram, Maccabi, or payment systems.

- [ ] **Step 5: Perform the local HTTP smoke**

Start the server with isolated data, verify `/health`, bootstrap administrator login, admin user listing, personal login, `/api/dashboard/snapshot`, logout, and 401 after logout. Record live Maccabi/Telegram interaction as manual verification not performed unless it was actually performed.

- [ ] **Step 6: Final security review**

Search responses and frontend assets for `web_password_hash`, `storageState`, `proxyPassword`, `telegramToken`, and `ENCRYPTION_KEY`. Confirm no personal route reads `userId` from request input and every admin route passes through `requireAdmin`.

- [ ] **Step 7: Commit verification documentation and any test-only corrections**

```bash
git add TESTING.md
git commit -m "docs: add personal dashboard verification"
```

## Completion Gate

Before claiming completion, use `superpowers:verification-before-completion` and report separately:

- automated checks run and their exact results;
- local isolated smoke steps actually performed;
- any live Telegram/Maccabi interaction not performed;
- the list of commits created for Tasks 1–9;
- confirmation that unrelated pre-existing worktree changes were preserved.
