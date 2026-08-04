# Telegram Owner Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Always add a found ticket to the cart, ask the configured Telegram chat to select an owner from the site's live **שיוך בעלים** list, verify the site's assignment, and send a direct cart/payment link without submitting payment.

**Architecture:** Add a focused Telegram long-polling selector and a focused Playwright owner-assignment adapter. `Monitor` coordinates availability, cart insertion, owner prompts, retries, and final notification while keeping identifiers in memory only. The dashboard removes the Auto Purchase toggle and the server refuses to start monitoring when Telegram selection cannot be used safely.

**Tech Stack:** Node.js CommonJS, Node `fetch`, Telegram Bot API, Playwright 1.57, Express, vanilla browser JavaScript, `node:test` + `node:assert/strict`.

## Global Constraints

- Owner choice is always explicit; never automatically choose a person.
- Telegram messages and callback payloads must not contain identity numbers or internal site user IDs.
- Owner mappings live in memory only and are discarded after success, rejection exhaustion, timeout, cancellation, or shutdown.
- Accept callbacks only from the configured Telegram Chat ID and the active one-time nonce.
- Owner selection expires after exactly `180000` ms.
- Once a ticket enters the cart, pause availability monitoring to protect that cart.
- Never enter payment data, save a payment method, press a final payment button, or confirm an order.
- Keep legacy `autoPurchase` settings readable for compatibility, but never use them to decide whether cart automation runs.
- Use TDD for every production change: failing test, observed failure, minimal implementation, passing targeted test, full regression test.

---

## File Map

- Create `telegram-owner-selector.js`: Telegram send, callback validation, long polling, timeout, cancellation, and callback acknowledgement.
- Create `owner-assignment.js`: owner-name redaction, live candidate discovery, exact owner application, and assignment verification on the cart page.
- Modify `monitor.js`: always-on cart trigger and orchestration between the two new units.
- Modify `server.js`: reject monitor start when Telegram credentials are unavailable.
- Modify `settings-store.js`: retain legacy compatibility while removing `autoPurchase` from public/default behavior.
- Modify `public/index.html`: remove the Auto Purchase checkbox and explain the Telegram owner flow.
- Modify `public/app.js`: stop reading and sending `autoPurchase`.
- Create `test/telegram-owner-selector.test.js`: Telegram protocol and security tests.
- Create `test/owner-assignment.test.js`: parsing, privacy, discovery, assignment success, and rejection tests.
- Modify `test/monitor.test.js`: orchestration, cancellation, and multi-ticket tests.
- Modify `test/settings-store.test.js`: legacy setting compatibility and public settings tests.
- Modify `TESTING.md`: document safe local verification without using a real cart or real assignment.

---

### Task 1: Secure Telegram Owner Selector

**Files:**
- Create: `telegram-owner-selector.js`
- Create: `test/telegram-owner-selector.test.js`

**Interfaces:**
- Consumes: `{ token, chatId, fetchImpl, nonceFactory, now, timeoutMs }` constructor dependencies.
- Produces: `new TelegramOwnerSelector(options)`.
- Produces: `chooseOwner({ ticketNumber, candidates, signal }) -> Promise<{ status: 'selected', candidateKey: string } | { status: 'timeout' } | { status: 'cancelled' } | { status: 'error', message: string }>`.
- Candidate input shape: `{ key: string, name: string }`; no identifier is accepted by this module.

- [ ] **Step 1: Write the failing keyboard/privacy test**

```js
// test/telegram-owner-selector.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const TelegramOwnerSelector = require('../telegram-owner-selector');

test('sends owner names without identity data and returns the selected opaque key', async () => {
  const requests = [];
  const responses = [
    { ok: true, result: { message_id: 51 } },
    { ok: true, result: [{
      update_id: 90,
      callback_query: {
        id: 'callback-1',
        data: 'owner:fixednonce:b',
        message: { chat: { id: 12345 } },
      },
    }] },
    { ok: true, result: true },
  ];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    return { ok: true, json: async () => responses.shift() };
  };
  const selector = new TelegramOwnerSelector({
    token: 'test-token',
    chatId: '12345',
    fetchImpl,
    nonceFactory: () => 'fixednonce',
    now: () => 0,
  });

  const result = await selector.chooseOwner({
    ticketNumber: 1,
    candidates: [
      { key: 'a', name: 'בעלים א' },
      { key: 'b', name: 'בעלים ב' },
    ],
  });

  assert.deepEqual(result, { status: 'selected', candidateKey: 'b' });
  const sendBody = JSON.parse(requests[0].options.body);
  assert.deepEqual(sendBody.reply_markup.inline_keyboard, [
    [{ text: 'בעלים א', callback_data: 'owner:fixednonce:a' }],
    [{ text: 'בעלים ב', callback_data: 'owner:fixednonce:b' }],
  ]);
  assert.doesNotMatch(JSON.stringify(sendBody), /\d{9}/);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test test/telegram-owner-selector.test.js`

Expected: FAIL with `Cannot find module '../telegram-owner-selector'`.

- [ ] **Step 3: Implement message sending, nonce callbacks, and valid selection**

```js
// telegram-owner-selector.js
const crypto = require('crypto');

class TelegramOwnerSelector {
  constructor({
    token,
    chatId,
    fetchImpl = fetch,
    nonceFactory = () => crypto.randomBytes(8).toString('hex'),
    now = () => Date.now(),
    timeoutMs = 180000,
  }) {
    this.token = token;
    this.chatId = String(chatId);
    this.fetchImpl = fetchImpl;
    this.nonceFactory = nonceFactory;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.updateOffset = 0;
  }

  async _call(method, body) {
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(`Telegram ${method} failed`);
    }
    return payload.result;
  }

  async chooseOwner({ ticketNumber, candidates, signal }) {
    const nonce = this.nonceFactory();
    const allowed = new Set(candidates.map(candidate => candidate.key));
    await this._call('sendMessage', {
      chat_id: this.chatId,
      text: `בחר בעלים לכרטיס ${ticketNumber}`,
      reply_markup: {
        inline_keyboard: candidates.map(candidate => [{
          text: candidate.name,
          callback_data: `owner:${nonce}:${candidate.key}`,
        }]),
      },
    });

    const deadline = this.now() + this.timeoutMs;
    while (this.now() < deadline) {
      if (signal?.aborted) return { status: 'cancelled' };
      const updates = await this._call('getUpdates', {
        offset: this.updateOffset,
        timeout: 20,
        allowed_updates: ['callback_query'],
      });
      for (const update of updates) {
        this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
        const query = update.callback_query;
        if (!query) continue;
        const [prefix, callbackNonce, candidateKey] = String(query.data || '').split(':');
        if (
          prefix !== 'owner' || callbackNonce !== nonce ||
          String(query.message?.chat?.id) !== this.chatId || !allowed.has(candidateKey)
        ) continue;
        await this._call('answerCallbackQuery', { callback_query_id: query.id });
        return { status: 'selected', candidateKey };
      }
    }
    return { status: 'timeout' };
  }
}

module.exports = TelegramOwnerSelector;
```

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run: `node --test test/telegram-owner-selector.test.js`

Expected: PASS, 1 test, 0 failures.

- [ ] **Step 5: Add failing security, timeout, and cancellation tests**

Add separate tests using controlled `now()` values and Telegram update fixtures:

```js
test('ignores foreign chat, stale nonce, and unknown candidate callbacks', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = url.split('/').pop();
    calls.push({ method, body: options.body ? JSON.parse(options.body) : {} });
    if (method === 'sendMessage') {
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 51 } }) };
    }
    if (method === 'getUpdates') {
      return { ok: true, json: async () => ({ ok: true, result: [
        { update_id: 1, callback_query: { id: 'foreign', data: 'owner:fixednonce:a', message: { chat: { id: 999 } } } },
        { update_id: 2, callback_query: { id: 'stale', data: 'owner:oldnonce:a', message: { chat: { id: 12345 } } } },
        { update_id: 3, callback_query: { id: 'unknown', data: 'owner:fixednonce:z', message: { chat: { id: 12345 } } } },
        { update_id: 4, callback_query: { id: 'accepted', data: 'owner:fixednonce:b', message: { chat: { id: 12345 } } } },
      ] }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: true }) };
  };
  const selector = new TelegramOwnerSelector({
    token: 'test-token', chatId: '12345', fetchImpl,
    nonceFactory: () => 'fixednonce', now: () => 0,
  });

  const result = await selector.chooseOwner({
    ticketNumber: 1,
    candidates: [{ key: 'a', name: 'בעלים א' }, { key: 'b', name: 'בעלים ב' }],
  });

  assert.deepEqual(result, { status: 'selected', candidateKey: 'b' });
  assert.deepEqual(
    calls.filter(call => call.method === 'answerCallbackQuery').map(call => call.body.callback_query_id),
    ['accepted']
  );
});

test('returns timeout after 180000 ms without a valid callback', async () => {
  let clock = 0;
  const selector = new TelegramOwnerSelector({
    token: 'test-token', chatId: '12345',
    now: () => (clock += 180000),
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) }),
  });
  assert.deepEqual(
    await selector.chooseOwner({ ticketNumber: 1, candidates: [{ key: 'a', name: 'בעלים א' }] }),
    { status: 'timeout' }
  );
});

test('returns cancelled without applying a late callback', async () => {
  const controller = new AbortController();
  controller.abort();
  const methods = [];
  const selector = new TelegramOwnerSelector({
    token: 'test-token', chatId: '12345',
    fetchImpl: async url => {
      methods.push(url.split('/').pop());
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 51 } }) };
    },
  });
  assert.deepEqual(
    await selector.chooseOwner({
      ticketNumber: 1,
      candidates: [{ key: 'a', name: 'בעלים א' }],
      signal: controller.signal,
    }),
    { status: 'cancelled' }
  );
  assert.deepEqual(methods, ['sendMessage']);
});
```

- [ ] **Step 6: Implement the minimal validation/error branches and run tests**

Rename the Step 3 loop to `_chooseOwner` and expose this guarded method:

```js
async chooseOwner(request) {
  try {
    return await this._chooseOwner(request);
  } catch (error) {
    if (request.signal?.aborted || error.name === 'AbortError') {
      return { status: 'cancelled' };
    }
    return { status: 'error', message: error.message };
  }
}
```

Inside `_chooseOwner`, check `signal?.aborted` immediately after `sendMessage` and before every `getUpdates` call. Acknowledge only the accepted callback. Pass `signal` into `_call('getUpdates', body, { signal })`, and have `_call` forward that signal to `fetchImpl` so `stop()` can interrupt an outstanding long poll.

Run: `node --test test/telegram-owner-selector.test.js`

Expected: PASS, all selector tests, 0 failures.

- [ ] **Step 7: Commit Task 1**

```bash
git add telegram-owner-selector.js test/telegram-owner-selector.test.js
git commit -m "feat: add secure Telegram owner selector"
```

---

### Task 2: Ticket-Site Owner Assignment Adapter

**Files:**
- Create: `owner-assignment.js`
- Create: `test/owner-assignment.test.js`

**Interfaces:**
- Produces: `redactOwnerName(displayText: string) -> string`.
- Produces: `discoverOwnerCandidates(page) -> Promise<{ required: false } | { required: true, candidates: Array<{ key: string, name: string, identifier: string }> }>`.
- Produces: `applyOwnerCandidate(page, candidate) -> Promise<{ status: 'assigned' } | { status: 'rejected', reason: string }>`.
- The candidate `identifier` remains inside `owner-assignment.js` and `Monitor` memory; it is never passed to `TelegramOwnerSelector`.

- [ ] **Step 1: Write failing redaction and candidate parsing tests**

```js
// test/owner-assignment.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  redactOwnerName,
  parseOwnerCandidates,
} = require('../owner-assignment');

test('removes a trailing identity number from an owner display label', () => {
  assert.equal(redactOwnerName('בעלים א (000000001)'), 'בעלים א');
});

test('creates opaque keys while retaining identifiers only in memory', () => {
  assert.deepEqual(parseOwnerCandidates([
    { text: 'בעלים א (000000001)', identifier: '000000001' },
    { text: 'בעלים ב (000000002)', identifier: '000000002' },
  ]), [
    { key: '0', name: 'בעלים א', identifier: '000000001' },
    { key: '1', name: 'בעלים ב', identifier: '000000002' },
  ]);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test test/owner-assignment.test.js`

Expected: FAIL with `Cannot find module '../owner-assignment'`.

- [ ] **Step 3: Implement pure redaction and parsing helpers**

```js
// owner-assignment.js
function redactOwnerName(displayText) {
  return String(displayText || '').replace(/\s*\(\d{5,}\)\s*$/, '').trim();
}

function parseOwnerCandidates(items) {
  return items
    .filter(item => item.identifier && redactOwnerName(item.text))
    .map((item, index) => ({
      key: String(index),
      name: redactOwnerName(item.text),
      identifier: String(item.identifier),
    }));
}
```

Export both helpers, run `node --test test/owner-assignment.test.js`, and expect both tests to pass.

- [ ] **Step 4: Write failing discovery tests**

Add this page fake and the two discovery assertions:

```js
function makeOwnerPageFake({ assignmentRequired, owners = [] }) {
  let opened = false;
  return {
    locator: selector => {
      assert.equal(selector, '.transaction-ticket .fnAssignButton:visible');
      return {
        count: async () => assignmentRequired ? 1 : 0,
        first: () => ({ click: async () => { opened = true; } }),
      };
    },
    evaluate: async () => {
      assert.equal(opened, true);
      return owners;
    },
  };
}

test('returns required false when no assignment button exists', async () => {
  const page = makeOwnerPageFake({ assignmentRequired: false });
  assert.deepEqual(await discoverOwnerCandidates(page), { required: false });
});

test('discovers every owner from the active assignment dropdown', async () => {
  const page = makeOwnerPageFake({
    assignmentRequired: true,
    owners: [
      { text: 'בעלים א (000000001)', identifier: '000000001' },
      { text: 'בעלים ב (000000002)', identifier: '000000002' },
    ],
  });
  const result = await discoverOwnerCandidates(page);
  assert.equal(result.required, true);
  assert.deepEqual(result.candidates.map(x => ({ key: x.key, name: x.name })), [
    { key: '0', name: 'בעלים א' },
    { key: '1', name: 'בעלים ב' },
  ]);
});
```

- [ ] **Step 5: Implement live discovery**

Use the first visible `.transaction-ticket .fnAssignButton`, click it, and evaluate only its adjacent `.fnAssignDropDownDiv .fnAssignDropdownItem` controls:

```js
async function discoverOwnerCandidates(page) {
  const buttons = page.locator('.transaction-ticket .fnAssignButton:visible');
  if (await buttons.count() === 0) return { required: false };
  const button = buttons.first();
  await button.click();
  const items = await page.evaluate(() => {
    const activeButton = document.querySelector('.transaction-ticket .fnAssignButton:not(.hide)');
    const dropdown = activeButton?.nextElementSibling;
    return Array.from(dropdown?.querySelectorAll('.fnAssignDropdownItem') || []).map(item => ({
      text: (item.textContent || '').trim(),
      identifier: item.dataset.useridentifier || '',
    }));
  });
  const candidates = parseOwnerCandidates(items);
  if (candidates.length === 0) {
    throw new Error('Owner assignment is required but no candidates were found');
  }
  return { required: true, candidates };
}
```

Run: `node --test test/owner-assignment.test.js`

Expected: PASS, all parsing/discovery tests.

- [ ] **Step 6: Write failing assignment success and rejection tests**

```js
function makeAssignmentPageFake({ responseOk, accepted }) {
  return {
    waitForResponse: async predicate => {
      const response = {
        url: () => 'https://tickets.mhaifafc.com/Transaction2/ChangeIdentifier',
        request: () => ({ method: () => 'POST' }),
        ok: () => responseOk,
      };
      assert.equal(predicate(response), true);
      return response;
    },
    evaluate: async (_fn, identifier) => identifier === '000000001',
    waitForFunction: async () => {
      if (!accepted) {
        const error = new Error('timeout');
        error.name = 'TimeoutError';
        throw error;
      }
    },
  };
}

test('reports assigned only after ChangeIdentifier and accepted DOM state', async () => {
  const page = makeAssignmentPageFake({ responseOk: true, accepted: true });
  assert.deepEqual(
    await applyOwnerCandidate(page, { key: '0', name: 'בעלים א', identifier: '000000001' }),
    { status: 'assigned' }
  );
});

test('reports rejected when the site keeps the identifier invalid', async () => {
  const page = makeAssignmentPageFake({ responseOk: true, accepted: false });
  assert.deepEqual(
    await applyOwnerCandidate(page, { key: '0', name: 'בעלים א', identifier: '000000001' }),
    { status: 'rejected', reason: 'The ticketing site rejected this owner' }
  );
});
```

- [ ] **Step 7: Implement verified assignment**

Add the verified site mutation without interpolating identity data into a CSS selector:

```js
async function applyOwnerCandidate(page, candidate) {
  const responsePromise = page.waitForResponse(response =>
    response.url().includes('/Transaction2/ChangeIdentifier') &&
    response.request().method() === 'POST'
  );
  const clicked = await page.evaluate(identifier => {
    const buttons = Array.from(document.querySelectorAll('.transaction-ticket .fnAssignButton'));
    const button = buttons.find(item => !item.classList.contains('hide'));
    if (!button) return false;
    button.click();
    const dropdown = button.nextElementSibling;
    const target = Array.from(dropdown?.querySelectorAll('.fnAssignDropdownItem') || [])
      .find(item => item.dataset.useridentifier === identifier);
    if (!target) return false;
    target.click();
    return true;
  }, candidate.identifier);
  if (!clicked) throw new Error('Selected owner is no longer available');

  const response = await responsePromise;
  if (!response.ok()) throw new Error(`ChangeIdentifier returned HTTP ${response.status()}`);
  try {
    await page.waitForFunction(identifier => {
      const input = document.querySelector('.transaction-ticket .fnIdentifier');
      return input?.value === identifier && !input.classList.contains('invalid');
    }, candidate.identifier, { timeout: 5000 });
    return { status: 'assigned' };
  } catch (error) {
    if (error.name === 'TimeoutError') {
      return { status: 'rejected', reason: 'The ticketing site rejected this owner' };
    }
    throw error;
  }
}
```

Export `discoverOwnerCandidates` and `applyOwnerCandidate` with the two pure helpers.

Run: `node --test test/owner-assignment.test.js`

Expected: PASS, all adapter tests, 0 failures.

- [ ] **Step 8: Commit Task 2**

```bash
git add owner-assignment.js test/owner-assignment.test.js
git commit -m "feat: add verified cart owner assignment"
```

---

### Task 3: Monitor Orchestration and Retry Flow

**Files:**
- Modify: `monitor.js:3-75,312-345,456-565`
- Modify: `test/monitor.test.js`
- Modify: `test/availability.test.js`

**Interfaces:**
- Consumes: `TelegramOwnerSelector`, `discoverOwnerCandidates`, and `applyOwnerCandidate` from Tasks 1-2.
- Produces: `Monitor._completeOwnerAssignments() -> Promise<{ status: 'complete' | 'manual', reason?: string }>`.
- Produces: `Monitor._finishCartOwnerFlow() -> Promise<{ status: 'complete' | 'manual', reason?: string }>`.
- Produces: structured `Monitor._tryAutoPurchase(sectionId) -> Promise<{ cartReady: boolean, assignments: 'complete' | 'manual' | 'failed' }>`.

- [ ] **Step 1: Write the failing explicit-choice/rejection test**

```js
test('re-prompts without an owner rejected by the ticketing site', async () => {
  const monitor = new Monitor();
  monitor.running = true;
  monitor.settings = {
    telegramToken: 'token',
    telegramChatId: '12345',
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=5989',
  };
  const prompts = [];
  monitor._ownerSelector = {
    chooseOwner: async request => {
      prompts.push(request.candidates.map(candidate => candidate.key));
      return { status: 'selected', candidateKey: prompts.length === 1 ? '0' : '1' };
    },
  };
  monitor._ownerBrowser = {
    discover: async () => ({ required: true, candidates: [
      { key: '0', name: 'בעלים א', identifier: 'id-a' },
      { key: '1', name: 'בעלים ב', identifier: 'id-b' },
    ] }),
    apply: async (_page, candidate) => candidate.key === '0'
      ? { status: 'rejected', reason: 'not eligible' }
      : { status: 'assigned' },
  };

  assert.deepEqual(await monitor._completeOwnerAssignments(), { status: 'complete' });
  assert.deepEqual(prompts, [['0', '1'], ['1']]);
});
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run: `node --test --test-name-pattern="re-prompts" test/monitor.test.js`

Expected: FAIL because `_completeOwnerAssignments` does not exist.

- [ ] **Step 3: Implement the orchestration loop**

Add imports and injectable defaults so unit tests never create real Telegram or browser traffic:

```js
const TelegramOwnerSelector = require('./telegram-owner-selector');
const ownerAssignment = require('./owner-assignment');

constructor({ ownerSelectorFactory, ownerBrowser } = {}) {
  super();
  this.running = false;
  this.browser = null;
  this.context = null;
  this.page = null;
  this.sections = {};
  this.stats = { checks: 0, alerts: 0, errors: 0, startedAt: null, lastCheck: null };
  this._labelToOnclickId = {};
  this._onclickIdToLabel = {};
  this.settings = null;
  this._stopRequested = false;
  this._browserCleanupPromises = new WeakMap();
  this._queueDetected = false;
  this._sectorsInfoUrl = null;
  this._ownerSelectorFactory = ownerSelectorFactory || (settings =>
    new TelegramOwnerSelector({
      token: settings.telegramToken,
      chatId: settings.telegramChatId,
    })
  );
  this._ownerBrowser = ownerBrowser || {
    discover: ownerAssignment.discoverOwnerCandidates,
    apply: ownerAssignment.applyOwnerCandidate,
  };
  this._ownerSelector = null;
  this._ownerSelectionAbort = null;
}
```

At the start of `start(settings)`, create the flow-scoped dependencies:

```js
this._ownerSelectionAbort = new AbortController();
this._ownerSelector = this._ownerSelectorFactory(settings);
```

Move `_stopRequested = true` and `this._ownerSelectionAbort?.abort()` before `stop()`'s early-return guard so a pending Telegram long poll is always cancelled.

Then implement this behavior:

```js
async _completeOwnerAssignments() {
  let ticketNumber = 1;
  while (!this._stopRequested) {
    const discovered = await this._ownerBrowser.discover(this.page);
    if (!discovered.required) return { status: 'complete' };
    let remaining = discovered.candidates;

    while (remaining.length > 0 && !this._stopRequested) {
      const choice = await this._ownerSelector.chooseOwner({
        ticketNumber,
        candidates: remaining.map(({ key, name }) => ({ key, name })),
        signal: this._ownerSelectionAbort.signal,
      });
      if (choice.status !== 'selected') {
        return { status: 'manual', reason: choice.status };
      }
      const candidate = remaining.find(item => item.key === choice.candidateKey);
      const result = await this._ownerBrowser.apply(this.page, candidate);
      if (result.status === 'assigned') break;
      remaining = remaining.filter(item => item.key !== candidate.key);
      await this._notify(`⚠️ ${candidate.name} אינו זכאי לכרטיס הזה. בחר בעלים אחר.`);
    }

    if (remaining.length === 0) return { status: 'manual', reason: 'no-eligible-owner' };
    ticketNumber++;
  }
  return { status: 'manual', reason: 'cancelled' };
}
```

Create a fresh `AbortController` at `start()` and abort it in `stop()` and browser cleanup.

- [ ] **Step 4: Run the retry test and verify GREEN**

Run: `node --test --test-name-pattern="re-prompts" test/monitor.test.js`

Expected: PASS, 1 matching test.

- [ ] **Step 5: Add failing multi-ticket, no-owner, timeout, and stop tests**

Add these concrete tests:

```js
test('assigns multiple tickets sequentially', async () => {
  const monitor = new Monitor();
  const prompts = [];
  let discoveryCount = 0;
  monitor._stopRequested = false;
  monitor._ownerSelectionAbort = new AbortController();
  monitor._ownerSelector = {
    chooseOwner: async request => {
      prompts.push(request.ticketNumber);
      return { status: 'selected', candidateKey: '0' };
    },
  };
  monitor._ownerBrowser = {
    discover: async () => (++discoveryCount <= 2 ? {
      required: true,
      candidates: [{ key: '0', name: 'בעלים א', identifier: `owner-${discoveryCount}` }],
    } : { required: false }),
    apply: async () => ({ status: 'assigned' }),
  };

  assert.deepEqual(await monitor._completeOwnerAssignments(), { status: 'complete' });
  assert.deepEqual(prompts, [1, 2]);
});

test('skips Telegram when the cart requires no owner assignment', async () => {
  const monitor = new Monitor();
  monitor._stopRequested = false;
  monitor._ownerSelectionAbort = new AbortController();
  monitor._ownerSelector = { chooseOwner: async () => assert.fail('must not prompt') };
  monitor._ownerBrowser = { discover: async () => ({ required: false }) };
  assert.deepEqual(await monitor._completeOwnerAssignments(), { status: 'complete' });
});

test('returns manual timeout without applying an owner', async () => {
  const monitor = new Monitor();
  let applyCalls = 0;
  monitor._stopRequested = false;
  monitor._ownerSelectionAbort = new AbortController();
  monitor._ownerSelector = { chooseOwner: async () => ({ status: 'timeout' }) };
  monitor._ownerBrowser = {
    discover: async () => ({
      required: true,
      candidates: [{ key: '0', name: 'בעלים א', identifier: 'owner-a' }],
    }),
    apply: async () => { applyCalls++; },
  };
  assert.deepEqual(
    await monitor._completeOwnerAssignments(),
    { status: 'manual', reason: 'timeout' }
  );
  assert.equal(applyCalls, 0);
});

test('stop aborts owner selection before a candidate can be applied', async () => {
  const monitor = new Monitor();
  let applyCalls = 0;
  monitor.running = true;
  monitor._stopRequested = false;
  monitor._ownerSelectionAbort = new AbortController();
  monitor._ownerSelector = {
    chooseOwner: ({ signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
    }),
  };
  monitor._ownerBrowser = {
    discover: async () => ({
      required: true,
      candidates: [{ key: '0', name: 'בעלים א', identifier: 'owner-a' }],
    }),
    apply: async () => { applyCalls++; },
  };

  const flow = monitor._completeOwnerAssignments();
  await monitor.stop();
  assert.deepEqual(await flow, { status: 'manual', reason: 'cancelled' });
  assert.equal(applyCalls, 0);
});

test('checkout notification contains no owner identifier', async () => {
  const monitor = new Monitor();
  const selectorRequests = [];
  const notifications = [];
  let discoveryCount = 0;
  monitor.settings = {
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=5989',
    loginUrl: 'https://auth.mhaifafc.com/',
  };
  monitor._stopRequested = false;
  monitor._ownerSelectionAbort = new AbortController();
  monitor._ownerSelector = {
    chooseOwner: async request => {
      selectorRequests.push(request);
      return { status: 'selected', candidateKey: '1' };
    },
  };
  monitor._ownerBrowser = {
    discover: async () => (++discoveryCount === 1 ? {
      required: true,
      candidates: [
        { key: '0', name: 'בעלים א', identifier: '000000001' },
        { key: '1', name: 'בעלים ב', identifier: '000000002' },
      ],
    } : { required: false }),
    apply: async () => ({ status: 'assigned' }),
  };
  monitor._notify = async (message, options) => {
    notifications.push(Monitor.buildNotificationText(monitor.settings, message, options));
  };

  assert.deepEqual(await monitor._finishCartOwnerFlow(), { status: 'complete' });
  assert.deepEqual(selectorRequests[0].candidates, [
    { key: '0', name: 'בעלים א' },
    { key: '1', name: 'בעלים ב' },
  ]);
  assert.match(notifications[0], /\/Transaction2\/Edit/);
  assert.doesNotMatch(JSON.stringify(selectorRequests), /000000001|000000002/);
  assert.doesNotMatch(notifications.join('\n'), /000000001|000000002/);
});
```

- [ ] **Step 6: Implement all result branches and checkout notifications**

After successful cart insertion, navigate to `new URL('/Transaction2/Edit', settings.url)`, run `_completeOwnerAssignments()`, and send:

- Success: `✅ כל הכרטיסים שויכו. הסל מוכן לתשלום.` with `checkoutReady: true`.
- Manual timeout/error: `⚠️ נדרש להשלים את השיוך ידנית בסל.` with `checkoutReady: true`.
- Exhausted candidates: `⚠️ אף אחד מהאנשים שנבחרו אינו זכאי. יש להשלים ידנית.` with `checkoutReady: true`.

Put this result-to-message mapping in `_finishCartOwnerFlow()`. `_tryAutoPurchase()` calls `_finishCartOwnerFlow()` after navigating to `/Transaction2/Edit`, and returns the structured cart result to `_applyAvailability()` without sending a second alert.

```js
async _finishCartOwnerFlow() {
  let result;
  try {
    result = await this._completeOwnerAssignments();
  } catch (error) {
    this.log(`Owner assignment failed: ${error.message}`, 'error');
    result = { status: 'manual', reason: 'error' };
  }
  const messages = {
    complete: '✅ כל הכרטיסים שויכו. הסל מוכן לתשלום.',
    timeout: '⚠️ זמן הבחירה הסתיים. יש להשלים את השיוך ידנית בסל.',
    cancelled: '⚠️ בחירת הבעלים בוטלה. יש להשלים את השיוך ידנית בסל.',
    'no-eligible-owner': '⚠️ אף אחד מהאנשים שנבחרו אינו זכאי. יש להשלים ידנית.',
    error: '⚠️ לא ניתן להשלים את השיוך אוטומטית. יש להשלים ידנית בסל.',
  };
  const message = result.status === 'complete'
    ? messages.complete
    : (messages[result.reason] || messages.error);
  await this._notify(message, { checkoutReady: true });
  return result;
}
```

Set `this.running = false` once cart insertion succeeds, regardless of `pauseOnHit`, but keep the browser alive until the owner flow finishes. Let the existing `_runLoop()` `finally` close it only after `_tryAutoPurchase()` returns.

- [ ] **Step 7: Run monitor and availability tests**

Run: `node --test test/monitor.test.js test/availability.test.js`

Expected: PASS, all tests, 0 failures.

- [ ] **Step 8: Commit Task 3**

```bash
git add monitor.js test/monitor.test.js test/availability.test.js
git commit -m "feat: coordinate Telegram owner assignment"
```

---

### Task 4: Make Add-to-Cart Automation Always On

**Files:**
- Modify: `monitor.js:312-345,482-519`
- Modify: `test/monitor.test.js`
- Modify: `test/availability.test.js`

**Interfaces:**
- Changes monitoring behavior only; no new public API.
- Legacy `settings.autoPurchase` is ignored.

- [ ] **Step 1: Write failing tests proving legacy false cannot disable cart automation**

```js
test('refreshes for cart automation when API finds a watched ticket even if legacy autoPurchase is false', async () => {
  const monitor = new Monitor();
  let refreshReason = '';
  monitor.running = true;
  monitor.settings = { sections: ['116'], autoPurchase: false };
  monitor.sections = { 116: { status: 'unavailable' } };
  monitor._onclickIdToLabel = { 1648: '116' };
  monitor._fetchApiAvailability = async () => ({
    timestamp: null,
    sectors: [{ id: '1648', freeSeats: 1 }],
  });
  monitor._refreshDomAvailability = async reason => { refreshReason = reason; };

  await monitor._pollApiAvailability();
  assert.match(refreshReason, /auto-purchase/i);
});

test('attempts cart insertion on a newly available watched section without an autoPurchase setting', async () => {
  const monitor = new Monitor();
  let attempted = '';
  monitor.running = true;
  monitor.settings = { sections: ['101'], pauseOnHit: false };
  monitor.sections = { 101: { status: 'unavailable' } };
  monitor._tryAutoPurchase = async section => {
    attempted = section;
    return { cartReady: true, assignments: 'complete' };
  };
  monitor._notify = async () => {};

  await monitor._applyAvailability([{ id: '1614', label: '101' }]);
  assert.equal(attempted, '101');
});
```

- [ ] **Step 2: Run the two tests and verify RED**

Run: `node --test --test-name-pattern="legacy false|without an autoPurchase" test/monitor.test.js test/availability.test.js`

Expected: FAIL because both current branches depend on `settings.autoPurchase`.

- [ ] **Step 3: Remove both behavioral gates**

In `_pollApiAvailability`, calculate `newlyAvailableForPurchase` from watched/current status without checking `this.settings.autoPurchase`. In `_applyAvailability`, call `_tryAutoPurchase(newlyAvailable[0])` unconditionally whenever `newlyAvailable.length > 0`.

Do not change section filtering: only configured visual sections can trigger cart insertion.

- [ ] **Step 4: Run targeted and full monitoring tests**

Run: `node --test test/monitor.test.js test/availability.test.js`

Expected: PASS, all tests, 0 failures.

- [ ] **Step 5: Commit Task 4**

```bash
git add monitor.js test/monitor.test.js test/availability.test.js
git commit -m "feat: make ticket cart automation always on"
```

---

### Task 5: Settings, Dashboard, and Start Safety Gate

**Files:**
- Modify: `settings-store.js:5-30,65-90`
- Modify: `server.js:180-188`
- Modify: `public/index.html:150-161`
- Modify: `public/app.js:252-289`
- Modify: `test/settings-store.test.js`
- Modify: `test/monitor.test.js`

**Interfaces:**
- Produces: `validateMonitorPrerequisites(settings) -> void`, exported from `settings-store.js`.
- Accepts legacy `autoPurchase` patches for cached clients but omits it from `defaultSettings()` and `toPublic()`.

- [ ] **Step 1: Write failing settings/prerequisite tests**

```js
const {
  SettingsStore,
  validateSettingsPatch,
  validateMonitorPrerequisites,
} = require('../settings-store');

test('monitor prerequisites require Telegram token and chat ID', () => {
  assert.throws(
    () => validateMonitorPrerequisites({ telegramToken: '', telegramChatId: '' }),
    /Telegram token and chat ID are required/
  );
  assert.doesNotThrow(() => validateMonitorPrerequisites({
    telegramToken: 'token', telegramChatId: '12345',
  }));
});

test('public settings omit the legacy autoPurchase field', async () => {
  await withTempStore(store => {
    store.update({ autoPurchase: false });
    assert.equal('autoPurchase' in store.toPublic(), false);
  });
});
```

- [ ] **Step 2: Run settings tests and verify RED**

Run: `node --test test/settings-store.test.js`

Expected: FAIL because the prerequisite function does not exist and public settings still expose `autoPurchase`.

- [ ] **Step 3: Implement backward-compatible settings behavior**

Keep `autoPurchase` in `ALLOWED_FIELDS` and boolean validation so stale cached dashboards do not receive `unknown field`. Remove it from `defaultSettings()`. In `toPublic()`, add `delete out.autoPurchase;` before `return out;`.

Add:

```js
function validateMonitorPrerequisites(settings) {
  if (!settings.telegramToken || !settings.telegramChatId) {
    throw new SettingsValidationError('Telegram token and chat ID are required for owner selection');
  }
}
```

Export the function and call it in `POST /api/monitor/start` before `monitor.start(settings)`.

Update the import and route exactly as follows:

```js
const {
  SettingsStore,
  SettingsValidationError,
  validateMonitorPrerequisites,
} = require('./settings-store');

app.post('/api/monitor/start', async (req, res) => {
  const settings = loadSettings();
  try {
    validateMonitorPrerequisites(settings);
    await monitor.start(settings);
    res.json({ ok: true });
  } catch (error) {
    const status = error instanceof SettingsValidationError ? 400 : 500;
    res.status(status).json({ error: error.message });
  }
});
```

- [ ] **Step 4: Remove the dashboard toggle and add fixed explanatory copy**

Replace the checkbox block in `public/index.html` with:

```html
<div class="form-group">
  <span class="hint">
    Tickets found in your monitored sections are automatically added to the cart.
    Owner selection is sent to Telegram; payment always remains manual.
  </span>
</div>
```

Remove both JavaScript references:

```js
// Delete from fillForm:
$('cfgAutoPurchase').checked = !!s.autoPurchase;

// Delete from readForm output:
autoPurchase: $('cfgAutoPurchase').checked,
```

Keep `cfgDesiredQuantity` unchanged.

- [ ] **Step 5: Run settings and monitor tests**

Run: `node --test test/settings-store.test.js test/monitor.test.js`

Expected: PASS, all tests, 0 failures.

- [ ] **Step 6: Perform a static dashboard reference check**

Run: `rg -n "cfgAutoPurchase|Auto-add to cart" public settings-store.js server.js`

Expected: no matches.

- [ ] **Step 7: Commit Task 5**

```bash
git add settings-store.js server.js public/index.html public/app.js test/settings-store.test.js test/monitor.test.js
git commit -m "feat: require Telegram owner selection for monitoring"
```

---

### Task 6: Safe Integration Verification and Documentation

**Files:**
- Modify: `TESTING.md`

**Interfaces:**
- No new production interfaces.
- Produces documented local verification steps that never alter a real cart or owner assignment.

- [ ] **Step 1: Document safe verification**

Add a `Telegram owner assignment` section to `TESTING.md` with these commands and expectations:

````markdown
## Telegram owner assignment

Run automated coverage without contacting Telegram or the ticketing site:

```bash
npm test
npm run test:coverage
```

Before a supervised live test, use a non-production event/cart, set `desiredQuantity=1`,
confirm the configured Telegram Chat ID belongs to the operator, and stop at the cart link.
Never enter payment data or press the final payment button during verification.
````

- [ ] **Step 2: Run complete test verification**

Run: `npm test`

Expected: all tests PASS, 0 failures.

Run: `npm run test:coverage`

Expected: command exits `0`; no test contacts Telegram or `tickets.mhaifafc.com`.

- [ ] **Step 3: Run privacy and formatting verification**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `rg -n "fnAssignDropdownItem|data-useridentifier|telegramChatId|callback_data" telegram-owner-selector.js owner-assignment.js monitor.js`

Expected: identifiers are read only inside `owner-assignment.js`; Telegram receives only opaque keys and redacted names.

- [ ] **Step 4: Commit Task 6**

```bash
git add TESTING.md
git commit -m "docs: add safe owner assignment verification"
```

---

## Final Acceptance Checklist

- [ ] The dashboard has no Auto Purchase toggle.
- [ ] A newly available configured section always attempts cart insertion.
- [ ] The monitor pauses further scans as soon as the cart is ready.
- [ ] Telegram displays all live owner names without identity numbers.
- [ ] Only the configured chat and active nonce can select an owner.
- [ ] Rejected owners are removed before the next prompt.
- [ ] Multiple tickets are assigned sequentially.
- [ ] Timeout, cancellation, Telegram failure, no candidates, and assignment failure all fall back to the cart link.
- [ ] The browser verifies the assignment before reporting success.
- [ ] The process never submits payment.
- [ ] `npm test`, `npm run test:coverage`, and `git diff --check` pass.
