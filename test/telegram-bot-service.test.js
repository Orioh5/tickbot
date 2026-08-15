'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const UserStore = require('../bot/user-store');
const TelegramBotService = require('../bot/telegram-bot-service');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = url.split('/').pop();
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ method, body });
    const payload = responses.shift() ?? { ok: true, result: [] };
    return { ok: true, json: async () => payload };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function makeTextUpdate(userId, text, updateId = 1) {
  return {
    update_id: updateId,
    message: {
      from: { id: userId, username: `user${userId}` },
      chat: { id: userId, type: 'private' },
      text,
    },
  };
}

function makeCallbackUpdate(userId, data, updateId = 2, messageId = 77) {
  return {
    update_id: updateId,
    callback_query: {
      id: 'cq1',
      from: { id: userId },
      message: { message_id: messageId, chat: { id: userId, type: 'private' } },
      data,
    },
  };
}

function makeBot({ adminUserIds = [], extraUserIds = [], monitorCoordinator = null, secureLoginService = null, userSessionStore = null } = {}) {
  const store = new UserStore();
  // Pre-register any extra user IDs
  for (const uid of extraUserIds) {
    store.createUser({ telegramUserId: uid, username: `u${uid}` });
  }
  const effectiveSessionStore = userSessionStore ?? (monitorCoordinator ? {
    load: () => ({ cookies: [], origins: [] }),
  } : null);
  const botFactory = (fetchImpl) => new TelegramBotService({
    token: 'test-token',
    adminUserIds,
    userStore: store,
    secureLoginService,
    monitorCoordinator,
    userSessionStore: effectiveSessionStore,
    fetchImpl,
    now: () => 0,
  });
  return { store, botFactory };
}

// ── /start ─────────────────────────────────────────────────────────────────────

test('/start without an invite payload refuses an unknown user', async () => {
  const { botFactory } = makeBot();
  const fetch = makeFetch([{ ok: true, result: { message_id: 1 } }]);
  const bot = botFactory(fetch);
  await bot._dispatch(makeTextUpdate(100, '/start'));
  assert.equal(fetch.calls[0].method, 'sendMessage');
  assert.match(fetch.calls[0].body.text, /קישור הזמנה/);
  assert.equal(bot._getState('100').state, 'idle');
});

test('/start shows the current menu for a known user', async () => {
  const { store, botFactory } = makeBot();
  store.createUser({ telegramUserId: '42' });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);
  await bot._dispatch(makeTextUpdate(42, '/start'));
  assert.match(fetch.calls[0].body.text, /התחבר/);
});

test('/start auto-registers admin and shows their menu', async () => {
  const { store, botFactory } = makeBot({ adminUserIds: ['77'] });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);
  await bot._dispatch(makeTextUpdate(77, '/start'));
  assert.ok(store.getUser('77'), 'admin should be auto-registered');
  assert.match(fetch.calls[0].body.text, /התחבר/);
});

test('/start payload redeems invite without asking for text', async () => {
  const { store, botFactory } = makeBot();
  store.createInviteCode({ code: 'ABC', createdBy: '1', expiresAt: Date.now() + 60_000 });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);

  await bot._dispatch(makeTextUpdate(2, '/start ABC'));

  assert.ok(store.getUser('2'));
  assert.equal(bot._getState('2').state, 'idle');
  assert.match(fetch.calls.at(-1).body.text, /התחבר/);
});

test('/start payload for a revoked user does not consume an invitation', async () => {
  const { store, botFactory } = makeBot();
  store.createUser({ telegramUserId: '2' });
  store.revokeUser('2');
  store.createInviteCode({ code: 'FRESH', createdBy: '1', expiresAt: Date.now() + 60_000 });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);

  await bot._dispatch(makeTextUpdate(2, '/start FRESH'));

  assert.equal(store.getInviteCode('FRESH').used_by, null);
  assert.equal(store.getUser('2').revoked, 1);
  assert.match(fetch.calls.at(-1).body.text, /אין הרשאה/);
});

// ── invite code flow ────────────────────────────────────────────────────────

test('valid invite link registers user', async () => {
  const { store, botFactory } = makeBot({ adminUserIds: ['1'] });
  store.createInviteCode({ code: 'DEAD', createdBy: '1' });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);
  await bot._dispatch(makeTextUpdate(55, '/start DEAD', 1));
  assert.ok(store.getUser('55'), 'user should be registered');
  assert.match(fetch.calls[0].body.text, /התחבר/);
});

test('invalid invite link shows an error without opening a text flow', async () => {
  const { botFactory } = makeBot();
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);
  await bot._dispatch(makeTextUpdate(55, '/start BADINVITE', 1));
  assert.match(fetch.calls[0].body.text, /❌/);
  assert.equal(bot._getState('55').state, 'idle');
});

// ── /invite (admin) ─────────────────────────────────────────────────────────

test('/invite creates a Telegram deep link for an admin', async () => {
  const { store, botFactory } = makeBot({ adminUserIds: ['1'] });
  store.createUser({ telegramUserId: '1' });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);
  bot.setBotUsername('MhfcTestBot');
  await bot._dispatch(makeTextUpdate(1, '/invite'));
  const body = fetch.calls[0].body;
  const match = body.text.match(/https:\/\/t\.me\/MhfcTestBot\?start=([A-Z0-9_-]+)/);
  assert.ok(match);
  assert.ok(match[1].length >= 32);
});

test('admin invite returns a Telegram deep link', async () => {
  const { store, botFactory } = makeBot({ adminUserIds: ['1'] });
  store.createUser({ telegramUserId: '1' });
  const fetch = makeFetch([{ ok: true, result: {} }, { ok: true, result: {} }]);
  const bot = botFactory(fetch);
  bot.setBotUsername('MhfcTestBot');

  await bot._dispatch(makeCallbackUpdate(1, 'admin:invite'));

  assert.match(fetch.calls.at(-1).body.text, /https:\/\/t\.me\/MhfcTestBot\?start=/);
  assert.equal(fetch.calls.at(-1).body.parse_mode, undefined);
});

// ── main-menu callback routing ─────────────────────────────────────────────

test('menu:login uses the same action as /login', async () => {
  const { botFactory } = makeBot({
    extraUserIds: ['7'],
    secureLoginService: { createLoginLink: () => 'http://localhost/bot-login' },
  });
  const fetch = makeFetch([{ ok: true, result: {} }, { ok: true, result: {} }]);
  const bot = botFactory(fetch);

  await bot._dispatch(makeCallbackUpdate(7, 'menu:login'));

  assert.match(fetch.calls.at(-1).body.text, /http:\/\/localhost.*bot-login/);
});

test('menu:games discovers games for the clicking user', async () => {
  const discoverCalls = [];
  const coordinator = {
    discoverGames: async userId => {
      discoverCalls.push(String(userId));
      return [];
    },
  };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch([{ ok: true, result: {} }, { ok: true, result: {} }, { ok: true, result: {} }]);
  const bot = botFactory(fetch);

  await bot._dispatch(makeCallbackUpdate(7, 'menu:games'));

  assert.deepEqual(discoverCalls, ['7']);
});

test('change selection requires confirmation before stopping and then opens game selection', async () => {
  const lifecycle = [];
  const coordinator = {
    getStatus: () => ({ phase: 'monitoring' }),
    stopMonitor: async userId => lifecycle.push(`stop:${userId}`),
    discoverGames: async userId => {
      lifecycle.push(`games:${userId}`);
      return [];
    },
  };
  const { store, botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch(Array.from({ length: 8 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);

  await bot._dispatch(makeCallbackUpdate(7, 'menu:change'));

  assert.deepEqual(lifecycle, []);
  assert.deepEqual(
    fetch.calls.at(-1).body.reply_markup.inline_keyboard.flat().map(button => button.callback_data),
    ['change:confirm', 'change:cancel']
  );
  assert.deepEqual(
    fetch.calls.at(-1).body.reply_markup.inline_keyboard.flat().map(button => button.text),
    ['✅ כן, שנה בחירה', '❌ לא, השאר מעקב']
  );

  await bot._dispatch(makeCallbackUpdate(7, 'change:confirm'));

  assert.deepEqual(lifecycle, ['stop:7', 'games:7']);
  assert.equal(store.getMonitoringConfig('7').active, 0);
});

test('cancelling change selection preserves the current monitor and returns its lifecycle menu', async () => {
  const stopCalls = [];
  const coordinator = {
    getStatus: () => ({ phase: 'monitoring' }),
    stopMonitor: async userId => stopCalls.push(String(userId)),
  };
  const { botFactory } = makeBot({
    extraUserIds: ['7'],
    monitorCoordinator: coordinator,
    userSessionStore: { load: () => ({ cookies: [], origins: [] }) },
  });
  const fetch = makeFetch(Array.from({ length: 6 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);

  await bot._dispatch(makeCallbackUpdate(7, 'menu:change'));
  await bot._dispatch(makeCallbackUpdate(7, 'change:cancel'));

  assert.deepEqual(stopCalls, []);
  assert.equal(bot._getState('7').state, 'idle');
  assert.ok(fetch.calls.at(-1).body.reply_markup.inline_keyboard.flat()
    .some(button => button.callback_data === 'menu:change'));
});

test('one user cannot confirm another user change selection', async () => {
  const stopCalls = [];
  const coordinator = {
    getStatus: () => ({ phase: 'monitoring' }),
    stopMonitor: async userId => stopCalls.push(String(userId)),
  };
  const { botFactory } = makeBot({ extraUserIds: ['7', '8'], monitorCoordinator: coordinator });
  const fetch = makeFetch(Array.from({ length: 6 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);

  await bot._dispatch(makeCallbackUpdate(7, 'menu:change'));
  await bot._dispatch(makeCallbackUpdate(8, 'change:confirm'));

  assert.deepEqual(stopCalls, []);
  assert.equal(bot._getState('7').state, 'awaiting_change_confirmation');
});

test('stale callback only redisplays current menu', async () => {
  const stopCalls = [];
  const coordinator = {
    getStatus: () => ({ phase: 'idle' }),
    stopMonitor: async userId => stopCalls.push(String(userId)),
  };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch([{ ok: true, result: {} }, { ok: true, result: {} }]);
  const bot = botFactory(fetch);

  await bot._dispatch(makeCallbackUpdate(7, 'menu:stop'));

  assert.deepEqual(stopCalls, []);
  assert.match(fetch.calls.at(-1).body.text, /מה תרצה לעשות/);
});

test('admin menu callbacks require administrator authorization', async () => {
  const { store, botFactory } = makeBot({ extraUserIds: ['7'] });
  const fetch = makeFetch([{ ok: true, result: {} }, { ok: true, result: {} }]);
  const bot = botFactory(fetch);
  bot.setBotUsername('MhfcTestBot');

  await bot._dispatch(makeCallbackUpdate(7, 'admin:invite'));

  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM invite_codes').get().count, 0);
  assert.match(fetch.calls.at(-1).body.text, /מה תרצה לעשות/);
});

test('callbacks are acknowledged before private-chat authorization rejects them', async () => {
  const discoverCalls = [];
  const { botFactory } = makeBot({
    extraUserIds: ['7'],
    monitorCoordinator: { discoverGames: async userId => discoverCalls.push(String(userId)) },
  });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);
  const update = makeCallbackUpdate(7, 'menu:games');
  update.callback_query.message.chat = { id: -100123, type: 'supergroup' };

  await bot._dispatch(update);

  assert.deepEqual(discoverCalls, []);
  assert.equal(fetch.calls[0].method, 'answerCallbackQuery');
});

test('callbacks cannot run a registered user action in another private chat', async () => {
  const discoverCalls = [];
  const { botFactory } = makeBot({
    extraUserIds: ['7'],
    monitorCoordinator: { discoverGames: async userId => discoverCalls.push(String(userId)) },
  });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);
  const update = makeCallbackUpdate(7, 'menu:games');
  update.callback_query.message.chat = { id: 8, type: 'private' };

  await bot._dispatch(update);

  assert.deepEqual(discoverCalls, []);
  assert.equal(fetch.calls[0].method, 'answerCallbackQuery');
});

test('callbacks without an explicit private chat type cannot run menu actions', async () => {
  const discoverCalls = [];
  const { botFactory } = makeBot({
    extraUserIds: ['7'],
    monitorCoordinator: { discoverGames: async userId => discoverCalls.push(String(userId)) },
  });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);
  const update = makeCallbackUpdate(7, 'menu:games');
  delete update.callback_query.message.chat.type;

  await bot._dispatch(update);

  assert.deepEqual(discoverCalls, []);
  assert.equal(fetch.calls[0].method, 'answerCallbackQuery');
});

test('initialize registers the bot username from Telegram getMe', async () => {
  const { botFactory } = makeBot();
  const fetch = makeFetch([{ ok: true, result: { username: 'MhfcTestBot' } }]);
  const bot = botFactory(fetch);

  await bot.initialize();

  assert.equal(bot.botUsername, 'MhfcTestBot');
  assert.equal(fetch.calls[0].method, 'getMe');
});

test('initialize rejects a Telegram identity without a string username', async () => {
  const { botFactory } = makeBot();
  const bot = botFactory(makeFetch([{ ok: true, result: { username: { unexpected: true } } }]));

  await assert.rejects(bot.initialize(), /bot username/);
});

test('initializeWithRetry recovers from a transient getMe failure with deterministic backoff', async () => {
  let attempts = 0;
  const delays = [];
  const { botFactory } = makeBot();
  const bot = botFactory(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary getMe outage with secret-token');
    return {
      ok: true,
      json: async () => ({ ok: true, result: { username: 'RecoveredBot' } }),
    };
  });

  await bot.initializeWithRetry({
    maxAttempts: 3,
    baseDelayMs: 25,
    sleep: async delay => { delays.push(delay); },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [25]);
  assert.equal(bot.botUsername, 'RecoveredBot');
});

test('invite creation waits for the initialized bot username', async () => {
  const { store, botFactory } = makeBot({ adminUserIds: ['1'] });
  store.createUser({ telegramUserId: '1' });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);

  await bot._dispatch(makeTextUpdate(1, '/invite'));

  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM invite_codes').get().count, 0);
  assert.match(fetch.calls[0].body.text, /זהות הבוט/);
});

test('/invite refuses to exceed the ten-user MVP limit', async () => {
  const { store, botFactory } = makeBot({ adminUserIds: ['1'] });
  for (let id = 1; id <= 10; id++) store.createUser({ telegramUserId: String(id) });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);
  bot.setBotUsername('MhfcTestBot');
  await bot._dispatch(makeTextUpdate(1, '/invite'));
  assert.match(fetch.calls[0].body.text, /מגבלת.*10/);
});

// ── /users and /revoke (admin) ──────────────────────────────────────────────

test('/users lists users (admin)', async () => {
  const { store, botFactory } = makeBot({ adminUserIds: ['1'] });
  store.createUser({ telegramUserId: '1', username: 'admin' });
  store.createUser({ telegramUserId: '2', username: 'bob' });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);
  await bot._dispatch(makeTextUpdate(1, '/users'));
  assert.match(fetch.calls[0].body.text, /bob/);
});

test('/revoke revokes a user', async () => {
  const { store, botFactory } = makeBot({ adminUserIds: ['1'] });
  store.createUser({ telegramUserId: '1' });
  store.createUser({ telegramUserId: '2' });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);
  await bot._dispatch(makeTextUpdate(1, '/revoke 2'));
  assert.equal(store.getUser('2').revoked, 1);
  assert.match(fetch.calls[0].body.text, /בוטלה/);
});

test('/revoke stops automation and deletes the target session', async () => {
  const stopped = [];
  const deleted = [];
  const monitorCoordinator = {
    stopMonitor: async userId => stopped.push(String(userId)),
  };
  const userSessionStore = { delete: userId => deleted.push(String(userId)) };
  const { store, botFactory } = makeBot({
    adminUserIds: ['1'],
    monitorCoordinator,
    userSessionStore,
  });
  store.createUser({ telegramUserId: '1' });
  store.createUser({ telegramUserId: '2' });
  const bot = botFactory(makeFetch([{ ok: true, result: {} }]));
  bot._setState('2', 'awaiting_sections', { gameUrl: 'secret' });
  bot.registerCallbackHandler('targetnonce', '2', () => {}, 5000);

  await bot._dispatch(makeTextUpdate(1, '/revoke 2'));

  assert.deepEqual(stopped, ['2']);
  assert.deepEqual(deleted, ['2']);
  assert.equal(bot._getState('2').state, 'idle');
  assert.equal(bot._callbackHandlers.has('targetnonce'), false);
  assert.equal(store.getMonitoringConfig('2')?.active ?? 0, 0);
});

test('/revoke fails closed before a hung teardown and preserves a later session generation', async () => {
  let releaseStop;
  const stopGate = new Promise(resolve => { releaseStop = resolve; });
  let session = { generation: 'old', storageState: { cookies: [{ value: 'old' }] } };
  let stopSnapshot;
  let bot;
  let store;
  const userSessionStore = {
    load: () => session?.storageState ?? null,
    loadWithGeneration: () => session,
    deleteIfGeneration: (_userId, generation) => {
      if (session?.generation !== generation) return false;
      session = null;
      return true;
    },
    delete: () => { session = null; },
  };
  const monitorCoordinator = {
    stopMonitor: () => {
      stopSnapshot = {
        revoked: store.getUser('2').revoked,
        tokenUsed: store.getLoginToken('outstanding-token').used,
        active: store.getMonitoringConfig('2')?.active ?? 0,
        hasSession: Boolean(session),
        conversation: bot._getState('2').state,
        hasCallback: bot._callbackHandlers.has('targetnonce'),
      };
      session = { generation: 'fresh', storageState: { cookies: [{ value: 'fresh' }] } };
      return stopGate;
    },
  };
  const made = makeBot({ adminUserIds: ['1'], monitorCoordinator, userSessionStore });
  store = made.store;
  store.createUser({ telegramUserId: '1' });
  store.createUser({ telegramUserId: '2' });
  store.setMonitoringConfig('2', { gameUrl: 'u', sections: ['13'] });
  store.setMonitoringActive('2', true);
  store.saveLoginToken({ tokenHash: 'outstanding-token', userId: '2', expiresAt: 9999 });
  bot = made.botFactory(makeFetch([{ ok: true, result: {} }]));
  bot._setState('2', 'awaiting_confirmation', { gameUrl: 'secret' });
  bot.registerCallbackHandler('targetnonce', '2', () => {}, 10_000);

  const dispatch = bot._dispatch(makeTextUpdate(1, '/revoke 2'));
  const outcome = await Promise.race([
    dispatch.then(() => 'completed'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 50)),
  ]);
  releaseStop();
  await dispatch;

  assert.equal(outcome, 'completed');
  assert.deepEqual(stopSnapshot, {
    revoked: 1,
    tokenUsed: 1,
    active: 0,
    hasSession: false,
    conversation: 'idle',
    hasCallback: false,
  });
  assert.equal(session.generation, 'fresh');
  assert.equal(session.storageState.cookies[0].value, 'fresh');
});

test('sensitive bot commands are rejected outside a private chat', async () => {
  let linkCreated = false;
  const { store, botFactory } = makeBot({
    extraUserIds: ['42'],
    secureLoginService: { createLoginLink: () => { linkCreated = true; return 'https://secret'; } },
  });
  assert.ok(store.getUser('42'));
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);
  const update = makeTextUpdate(42, '/login');
  update.message.chat = { id: -100123, type: 'supergroup' };

  await bot._dispatch(update);

  assert.equal(linkCreated, false);
  assert.match(fetch.calls[0].body.text, /פרטי/);
});

// ── callback handler registration ──────────────────────────────────────────

test('registerCallbackHandler routes matching callback to handler', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['10'] });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);

  let received = null;
  bot.registerCallbackHandler('nonce1', '10', key => { received = key; }, 5000);
  await bot._dispatch(makeCallbackUpdate(10, 'nonce1:candidate_a'));
  assert.equal(received, 'candidate_a');
  assert.equal(bot._callbackHandlers.size, 0, 'handler should be deregistered');
});

test('registerCallbackHandler ignores callbacks from wrong user', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['10', '20'] });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);

  let received = null;
  bot.registerCallbackHandler('nonce2', '10', key => { received = key; }, 5000);
  // callback from user 20 should be ignored
  await bot._dispatch(makeCallbackUpdate(20, 'nonce2:candidate_a'));
  assert.equal(received, null);
  bot.deregisterCallbackHandler('nonce2');
});

test('deregisterCallbackHandler cleans up timer', () => {
  const { botFactory } = makeBot({ extraUserIds: ['1'] });
  const bot = botFactory(makeFetch([]));
  let called = false;
  bot.registerCallbackHandler('n', '1', () => { called = true; }, 50);
  bot.deregisterCallbackHandler('n');
  assert.equal(bot._callbackHandlers.size, 0);
  // handler should NOT be called after deregistration
  return new Promise(r => setTimeout(() => {
    assert.equal(called, false);
    r();
  }, 100));
});

// ── /stop and /status ───────────────────────────────────────────────────────

test('/stop with no queued or active monitor redisplays the current menu', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['5'] });
  const fetch = makeFetch([{ ok: true, result: {} }]);
  const bot = botFactory(fetch);
  await bot._dispatch(makeTextUpdate(5, '/stop'));
  assert.match(fetch.calls[0].body.text, /מה תרצה לעשות/);
});

test('stale login, games, retry, and setup callbacks cannot mutate any busy lifecycle', async () => {
  const phases = [
    'starting',
    'monitoring',
    'stopping',
    'owner-selection',
    'cart-interaction',
    'cart-verification',
    'cart-ready',
    'cart-recovery',
  ];

  for (const phase of phases) {
    for (const callback of ['menu:login', 'menu:games', 'games:retry', 'setup:confirm']) {
      let links = 0;
      let discoveries = 0;
      let starts = 0;
      const coordinator = {
        getStatus: () => ({ running: phase !== 'stopping', busy: true, phase }),
        discoverGames: async () => { discoveries += 1; return []; },
        startMonitor: async () => { starts += 1; return { status: 'started' }; },
      };
      const { botFactory } = makeBot({
        extraUserIds: ['7'],
        monitorCoordinator: coordinator,
        secureLoginService: {
          createLoginLink: () => { links += 1; return 'https://example.test/bot-login'; },
        },
        userSessionStore: { load: () => ({ cookies: [], origins: [] }) },
      });
      const bot = botFactory(makeFetch(Array.from({ length: 5 }, () => ({ ok: true, result: {} }))));
      bot._setState('7', 'awaiting_confirmation', {
        gameUrl: 'https://tickets.example.test/event/1',
        sections: ['13'],
        quantity: 1,
      });

      await bot._dispatch(makeCallbackUpdate(7, callback));

      assert.equal(links, 0, `${phase}:${callback}`);
      assert.equal(discoveries, 0, `${phase}:${callback}`);
      assert.equal(starts, 0, `${phase}:${callback}`);
    }
  }
});

// ── poll loop stop ──────────────────────────────────────────────────────────

test('start() begins polling and stop() halts it', async () => {
  let pollCount = 0;
  const fetch = async (url, opts = {}) => {
    pollCount++;
    // Stall until signal aborted
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
  };
  const { botFactory } = makeBot();
  const bot = botFactory(fetch);
  bot.start();
  await new Promise(r => setTimeout(r, 50));
  assert.ok(pollCount >= 1);
  await bot.stop();
});

test('dispatch logs expose only a stable error code, never exception secrets', async () => {
  const { botFactory } = makeBot();
  const bot = botFactory(makeFetch([]));
  bot._running = true;
  bot._call = async () => [{ update_id: 1 }];
  bot._dispatch = async () => {
    bot._running = false;
    throw new Error('https://user:password@example.test/?token=secret-token');
  };
  const captured = [];
  const originalConsoleError = console.error;
  console.error = (...parts) => { captured.push(parts.join(' ')); };
  try {
    await bot._loop(new AbortController().signal);
  } finally {
    console.error = originalConsoleError;
  }

  assert.match(captured.join('\n'), /code=DISPATCH_FAILED/);
  assert.doesNotMatch(captured.join('\n'), /password|example\.test|secret-token/);
});

test('game selection discovers real sections and renders inline section buttons', async () => {
  const coordinator = {
    discoverGames: async () => [{ name: 'Game', url: 'https://tickets.mhaifafc.com/game/1' }],
    discoverSections: async () => [{ label: '13', id: '1590' }, { label: '14', id: '1591' }],
  };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch([
    { ok: true, result: {} },
    { ok: true, result: {} },
    { ok: true, result: {} },
    { ok: true, result: {} },
  ]);
  const bot = botFactory(fetch);
  await bot._dispatch(makeTextUpdate(7, '/games'));
  await bot._dispatch(makeCallbackUpdate(7, 'game:0'));

  const keyboard = fetch.calls.at(-1).body.reply_markup.inline_keyboard.flat();
  assert.ok(keyboard.some(button => button.text.includes('13') && button.callback_data === 'section:13'));
  assert.ok(keyboard.some(button => button.callback_data === 'sections_done'));
});

test('away map shows available and sold-out combined areas as selectable buttons', async () => {
  const coordinator = {
    discoverGames: async () => [{
      name: 'משחק חוץ',
      url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=7000',
    }],
    discoverEventMap: async (_userId, game) => ({
      eventId: '7000',
      gameName: game.name,
      gameUrl: game.url,
      venueName: 'Away Ground',
      confidence: 'complete',
      areas: [
        { id: '900', label: '22,24', components: ['22', '24'], available: true, source: 'dom' },
        { id: null, label: '27,28', components: ['27', '28'], available: false, source: 'svg' },
      ],
    }),
  };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch(Array.from({ length: 8 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);

  await bot._dispatch(makeTextUpdate(7, '/games'));
  await bot._dispatch(makeCallbackUpdate(7, 'game:0'));

  const keyboard = fetch.calls.at(-1).body.reply_markup.inline_keyboard.flat();
  assert.ok(keyboard.some(button => button.text === '22,24' && button.callback_data === 'area:0'));
  assert.ok(keyboard.some(button => button.text === '27,28' && button.callback_data === 'area:1'));
});

test('dynamic section map uses the grouped four-column dev layout', async () => {
  const coordinator = {
    discoverGames: async () => [{ name: 'Game', url: 'https://tickets.mhaifafc.com/event/1' }],
    discoverEventMap: async (_userId, game) => ({
      gameName: game.name,
      gameUrl: game.url,
      areas: ['202', '203', '204', '205', '228'].map((label, index) => ({
        id: String(index), label, components: [label], available: true, source: 'dom',
      })),
    }),
  };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const bot = botFactory(makeFetch(Array.from({ length: 8 }, () => ({ ok: true, result: {} }))));

  await bot._dispatch(makeTextUpdate(7, '/games'));
  await bot._dispatch(makeCallbackUpdate(7, 'game:0'));

  const keyboard = bot.fetchImpl.calls.at(-1).body.reply_markup.inline_keyboard;
  assert.deepEqual(keyboard.slice(0, 4), [
    [{ text: '— Upper Avi Ran —', callback_data: 'noop' }],
    [
      { text: '202', callback_data: 'area:0' },
      { text: '203', callback_data: 'area:1' },
      { text: '204', callback_data: 'area:2' },
      { text: '205', callback_data: 'area:3' },
    ],
    [{ text: '— South Upper —', callback_data: 'noop' }],
    [{ text: '228', callback_data: 'area:4' }],
  ]);
});

test('game selection stores the section prompt message ID', async () => {
  const coordinator = {
    discoverSections: async () => [{ label: '13', id: '1590' }],
  };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch([
    { ok: true, result: {} },
    { ok: true, result: { message_id: 88 } },
  ]);
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_game', {
    games: [{ name: 'Game', url: 'https://tickets.mhaifafc.com/game/1' }],
  });

  await bot._dispatch(makeCallbackUpdate(7, 'game:0'));

  assert.equal(bot._getState('7').state, 'awaiting_sections');
  assert.equal(bot._getState('7').data.sectionMessageId, 88);
});

test('section selection finishes with quantity buttons restricted to 1-4', async () => {
  const coordinator = {
    discoverGames: async () => [],
    discoverSections: async () => [],
  };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch([
    { ok: true, result: {} },
    { ok: true, result: {} },
    { ok: true, result: {} },
    { ok: true, result: {} },
  ]);
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_sections', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    availableSections: ['13', '14'],
    sections: [],
    sectionMessageId: 77,
  });

  await bot._dispatch(makeCallbackUpdate(7, 'section:13'));
  await bot._dispatch(makeCallbackUpdate(7, 'sections_done'));

  const keyboard = fetch.calls.at(-1).body.reply_markup.inline_keyboard.flat();
  assert.deepEqual(keyboard.map(button => button.callback_data), ['quantity:1', 'quantity:2', 'quantity:3', 'quantity:4']);
});

test('section selection edits the original keyboard without sending a selection message', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: {} });
  const fetch = makeFetch([
    { ok: true, result: {} },
    { ok: true, result: {} },
    { ok: true, result: {} },
    { ok: true, result: {} },
  ]);
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_sections', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    availableSections: ['13', '14'],
    sections: [],
    sectionMessageId: 77,
  });

  await bot._dispatch(makeCallbackUpdate(7, 'section:13'));

  assert.deepEqual(fetch.calls.map(call => call.method), [
    'answerCallbackQuery',
    'editMessageReplyMarkup',
  ]);
  assert.equal(fetch.calls[1].body.chat_id, '7');
  assert.equal(fetch.calls[1].body.message_id, 77);
  const selectedButtons = fetch.calls[1].body.reply_markup.inline_keyboard.flat();
  assert.equal(selectedButtons.find(button => button.callback_data === 'section:13').text, '✅ 13');
  assert.equal(selectedButtons.find(button => button.callback_data === 'sections_done').text, '✅ סיימתי (1)');

  await bot._dispatch(makeCallbackUpdate(7, 'section:13', 3));

  assert.deepEqual(fetch.calls.map(call => call.method), [
    'answerCallbackQuery',
    'editMessageReplyMarkup',
    'answerCallbackQuery',
    'editMessageReplyMarkup',
  ]);
  const deselectedButtons = fetch.calls[3].body.reply_markup.inline_keyboard.flat();
  assert.equal(deselectedButtons.find(button => button.callback_data === 'section:13').text, '13');
  assert.equal(deselectedButtons.find(button => button.callback_data === 'sections_done').text, '✅ סיימתי (0)');
});

test('area selection edits the original keyboard without sending a selection message', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: {} });
  const fetch = makeFetch([
    { ok: true, result: {} },
    { ok: true, result: {} },
  ]);
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_sections', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    areas: [{ id: '900', label: '22,24', components: ['22', '24'], available: true, source: 'dom' }],
    availableSections: ['22,24'],
    sections: [],
    sectionMessageId: 77,
  });

  await bot._dispatch(makeCallbackUpdate(7, 'area:0'));

  assert.deepEqual(fetch.calls.map(call => call.method), [
    'answerCallbackQuery',
    'editMessageReplyMarkup',
  ]);
  assert.equal(fetch.calls[1].body.chat_id, '7');
  assert.equal(fetch.calls[1].body.message_id, 77);
  const selectedButtons = fetch.calls[1].body.reply_markup.inline_keyboard.flat();
  assert.equal(selectedButtons.find(button => button.callback_data === 'area:0').text, '✅ 22,24');
  assert.equal(selectedButtons.find(button => button.callback_data === 'sections_done').text, '✅ סיימתי (1)');
});

test('section keyboard edit failure preserves selection without a fallback message', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: {} });
  const fetch = makeFetch([
    { ok: true, result: {} },
    { ok: false, description: 'message is not modified: sensitive-detail' },
  ]);
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_sections', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    availableSections: ['13'],
    sections: [],
    sectionMessageId: 77,
  });

  const captured = [];
  const originalConsoleError = console.error;
  console.error = (...parts) => { captured.push(parts.join(' ')); };
  try {
    await assert.doesNotReject(() => bot._dispatch(makeCallbackUpdate(7, 'section:13')));
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(bot._getState('7').data.sections, ['13']);
  assert.deepEqual(fetch.calls.map(call => call.method), [
    'answerCallbackQuery',
    'editMessageReplyMarkup',
  ]);
  assert.match(captured.join('\n'), /code=TELEGRAM_EDIT_FAILED/);
  assert.doesNotMatch(captured.join('\n'), /message is not modified|sensitive-detail/);
});

test('area keyboard edit failure preserves selection without a fallback message', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: {} });
  const fetch = makeFetch([
    { ok: true, result: {} },
    { ok: false, description: 'message is not modified: sensitive-detail' },
  ]);
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_sections', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    areas: [{ id: '900', label: '22,24', components: ['22', '24'], available: true, source: 'dom' }],
    availableSections: ['22,24'],
    sections: [],
    sectionMessageId: 77,
  });

  const captured = [];
  const originalConsoleError = console.error;
  console.error = (...parts) => { captured.push(parts.join(' ')); };
  try {
    await assert.doesNotReject(() => bot._dispatch(makeCallbackUpdate(7, 'area:0')));
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(bot._getState('7').data.sections, ['22,24']);
  assert.deepEqual(fetch.calls.map(call => call.method), [
    'answerCallbackQuery',
    'editMessageReplyMarkup',
  ]);
  assert.match(captured.join('\n'), /code=TELEGRAM_EDIT_FAILED/);
  assert.doesNotMatch(captured.join('\n'), /message is not modified|sensitive-detail/);
});

test('stale section callbacks cannot mutate or advance the active selection', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: {} });
  const toggleFetch = makeFetch([{ ok: true, result: {} }, { ok: true, result: {} }]);
  const toggleBot = botFactory(toggleFetch);
  toggleBot._setState('7', 'awaiting_sections', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    availableSections: ['13'],
    sections: [],
    sectionMessageId: 88,
  });

  await toggleBot._dispatch(makeCallbackUpdate(7, 'section:13', 2, 77));

  assert.equal(toggleBot._getState('7').state, 'awaiting_sections');
  assert.deepEqual(toggleBot._getState('7').data.sections, []);
  assert.deepEqual(toggleFetch.calls.map(call => call.method), ['answerCallbackQuery', 'sendMessage']);

  const doneFetch = makeFetch([{ ok: true, result: {} }, { ok: true, result: {} }]);
  const doneBot = botFactory(doneFetch);
  doneBot._setState('7', 'awaiting_sections', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    availableSections: ['13'],
    sections: ['13'],
    sectionMessageId: 88,
  });

  await doneBot._dispatch(makeCallbackUpdate(7, 'sections_done', 2, 77));

  assert.equal(doneBot._getState('7').state, 'awaiting_sections');
  assert.deepEqual(doneFetch.calls.map(call => call.method), ['answerCallbackQuery', 'sendMessage']);
  assert.equal(doneFetch.calls[1].body.reply_markup.inline_keyboard.flat().some(button => button.callback_data.startsWith('quantity:')), false);
});

test('stale area callbacks cannot mutate the active selection', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: {} });
  const fetch = makeFetch([{ ok: true, result: {} }, { ok: true, result: {} }]);
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_sections', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    areas: [{ id: '900', label: '22,24', components: ['22', '24'], available: true, source: 'dom' }],
    availableSections: ['22,24'],
    sections: [],
    sectionMessageId: 88,
  });

  await bot._dispatch(makeCallbackUpdate(7, 'area:0', 2, 77));

  assert.equal(bot._getState('7').state, 'awaiting_sections');
  assert.deepEqual(bot._getState('7').data.sections, []);
  assert.deepEqual(fetch.calls.map(call => call.method), ['answerCallbackQuery', 'sendMessage']);
});

test('sections done with no selections keeps section selection active', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: {} });
  const fetch = makeFetch([{ ok: true, result: {} }, { ok: true, result: {} }]);
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_sections', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    availableSections: ['13'],
    sections: [],
    sectionMessageId: 77,
  });

  await bot._dispatch(makeCallbackUpdate(7, 'sections_done'));

  assert.equal(bot._getState('7').state, 'awaiting_sections');
  assert.match(fetch.calls[1].body.text, /בחר לפחות גוש אחד/);
  assert.equal(fetch.calls.some(call => call.body.reply_markup?.inline_keyboard.flat().some(button => button.callback_data.startsWith('quantity:'))), false);
});

test('quantity selection shows a sanitized confirmation summary without starting monitoring', async () => {
  const startCalls = [];
  const coordinator = {
    startMonitor: async (...args) => startCalls.push(args),
  };
  const { store, botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch([
    { ok: true, result: {} },
    { ok: true, result: {} },
    { ok: true, result: {} },
  ]);
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_quantity', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    gameName: 'Game',
    sections: ['13'],
  });

  await bot._dispatch(makeCallbackUpdate(7, 'quantity:2'));

  assert.equal(startCalls.length, 0);
  assert.equal(store.getMonitoringConfig('7'), null);
  assert.match(fetch.calls.at(-1).body.text, /Game.*13.*2/s);
  assert.doesNotMatch(fetch.calls.at(-1).body.text, /tickets\.mhaifafc\.com/);
  assert.deepEqual(
    fetch.calls.at(-1).body.reply_markup.inline_keyboard.flat().map(button => button.callback_data),
    ['setup:confirm', 'setup:back', 'setup:cancel']
  );
  assert.deepEqual(
    fetch.calls.at(-1).body.reply_markup.inline_keyboard.flat().map(button => button.text),
    ['▶️ התחל מעקב', '⬅️ חזור', '❌ ביטול']
  );
  assert.deepEqual(bot._getState('7'), {
    state: 'awaiting_confirmation',
    data: {
      gameUrl: 'https://tickets.mhaifafc.com/game/1',
      gameName: 'Game',
      sections: ['13'],
      quantity: 2,
    },
  });
});

test('setup confirmation claims the state before starting so a double click starts one monitor', async () => {
  const startCalls = [];
  let resolveStart;
  const coordinator = {
    getStatus: () => null,
    startMonitor: (...args) => {
      startCalls.push(args);
      return new Promise(resolve => { resolveStart = resolve; });
    },
  };
  const { store, botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch(Array.from({ length: 8 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_confirmation', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    gameName: 'Game',
    sections: ['13'],
    quantity: 2,
  });

  const first = bot._dispatch(makeCallbackUpdate(7, 'setup:confirm'));
  await new Promise(resolve => setImmediate(resolve));
  const second = bot._dispatch(makeCallbackUpdate(7, 'setup:confirm'));
  resolveStart({ status: 'queued' });
  await Promise.all([first, second]);

  assert.equal(startCalls.length, 1);
  assert.deepEqual(store.getMonitoringConfig('7'), {
    telegram_user_id: '7',
    game_url: 'https://tickets.mhaifafc.com/game/1',
    sections: ['13'],
    quantity: 2,
    active: 1,
    eventMetadata: {
      gameName: 'Game', venueName: null, confidence: 'unknown', areas: [],
    },
  });
  assert.equal(bot._getState('7').state, 'idle');
});

test('setup confirmation carries and persists dynamic event metadata', async () => {
  const startCalls = [];
  const coordinator = {
    getStatus: () => null,
    startMonitor: async (...args) => {
      startCalls.push(args);
      return { status: 'started' };
    },
  };
  const { store, botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch(Array.from({ length: 5 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);
  const areas = [{
    id: '900', label: '22,24', components: ['22', '24'], available: false, source: 'svg',
  }];
  bot._setState('7', 'awaiting_confirmation', {
    gameUrl: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=7000',
    gameName: 'משחק חוץ',
    venueName: 'Away Ground',
    confidence: 'complete',
    areas,
    sections: ['22,24'],
    quantity: 2,
  });

  await bot._dispatch(makeCallbackUpdate(7, 'setup:confirm'));

  assert.deepEqual(startCalls[0][1].areas, areas);
  assert.equal(startCalls[0][1].gameName, 'משחק חוץ');
  assert.equal(startCalls[0][1].venueName, 'Away Ground');
  assert.deepEqual(store.getMonitoringConfig('7').eventMetadata, {
    gameName: 'משחק חוץ', venueName: 'Away Ground', confidence: 'complete', areas,
  });
});

test('a failed confirmation restores the same setup and a retry starts monitoring once', async () => {
  let attempts = 0;
  const coordinator = {
    startMonitor: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary startup failure');
      return { status: 'queued' };
    },
  };
  const { store, botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch(Array.from({ length: 8 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);
  const setup = {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    gameName: 'Game',
    sections: ['13'],
    quantity: 2,
  };
  bot._setState('7', 'awaiting_confirmation', setup);

  await bot._dispatch(makeCallbackUpdate(7, 'setup:confirm'));

  assert.deepEqual(bot._getState('7'), { state: 'awaiting_confirmation', data: setup });
  assert.equal(store.getMonitoringConfig('7'), null);
  assert.deepEqual(
    fetch.calls.at(-1).body.reply_markup.inline_keyboard.flat().map(button => button.callback_data),
    ['setup:confirm', 'setup:back', 'setup:cancel']
  );

  await bot._dispatch(makeCallbackUpdate(7, 'setup:confirm'));

  assert.equal(attempts, 2);
  assert.equal(bot._getState('7').state, 'idle');
  assert.equal(store.getMonitoringConfig('7').active, 1);
});

test('a final Telegram failure after coordinator acceptance never restores confirmation', async () => {
  const startCalls = [];
  const coordinator = {
    ownsPersistence: true,
    getStatus: () => null,
    startMonitor: async (...args) => {
      startCalls.push(args);
      return { status: 'started' };
    },
  };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const bot = botFactory(makeFetch([{ ok: true, result: {} }]));
  bot._setState('7', 'awaiting_confirmation', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    gameName: 'Game',
    sections: ['13'],
    quantity: 2,
  });
  const sent = [];
  bot.sendMessage = async (_chatId, text) => {
    sent.push(text);
    if (text.includes('ניטור פעיל')) {
      throw new Error('Telegram secret-token https://private.example.test');
    }
  };
  const capturedLogs = [];
  const originalConsoleError = console.error;
  console.error = (...parts) => { capturedLogs.push(parts.join(' ')); };
  try {
    await bot._dispatch(makeCallbackUpdate(7, 'setup:confirm'));
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(startCalls.length, 1);
  assert.equal(bot._getState('7').state, 'idle');
  assert.equal(sent.filter(text => text.includes('סיכום הניטור')).length, 0);
  assert.doesNotMatch(capturedLogs.join('\n'), /secret-token|private\.example/);
});

test('setup back restores the quantity step without losing its selected game or sections', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['7'] });
  const fetch = makeFetch(Array.from({ length: 3 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_confirmation', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1', gameName: 'Game', sections: ['13'], quantity: 2,
  });

  await bot._dispatch(makeCallbackUpdate(7, 'setup:back'));

  assert.deepEqual(bot._getState('7'), {
    state: 'awaiting_quantity',
    data: { gameUrl: 'https://tickets.mhaifafc.com/game/1', gameName: 'Game', sections: ['13'] },
  });
  assert.deepEqual(
    fetch.calls.at(-1).body.reply_markup.inline_keyboard.flat().map(button => button.callback_data),
    ['quantity:1', 'quantity:2', 'quantity:3', 'quantity:4']
  );
});

test('setup cancel clears pending setup and returns to the main menu', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['7'] });
  const fetch = makeFetch(Array.from({ length: 3 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_confirmation', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1', gameName: 'Game', sections: ['13'], quantity: 2,
  });

  await bot._dispatch(makeCallbackUpdate(7, 'setup:cancel'));

  assert.equal(bot._getState('7').state, 'idle');
  assert.match(fetch.calls.at(-1).body.text, /מה תרצה לעשות/);
});

test('empty game discovery offers retry and home buttons', async () => {
  const coordinator = { discoverGames: async () => [] };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch(Array.from({ length: 3 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);

  await bot._dispatch(makeCallbackUpdate(7, 'menu:games'));

  const message = fetch.calls.at(-1).body;
  assert.equal(message.text, 'לא נמצאו משחקים זמינים כרגע.');
  assert.deepEqual(
    message.reply_markup.inline_keyboard.flat().map(button => button.callback_data),
    ['games:retry', 'menu:home']
  );
});

test('session expiry during game discovery does not expose an internal error', async () => {
  const error = Object.assign(new Error('Saved session expired: cookie details'), { code: 'SESSION_EXPIRED' });
  const coordinator = { discoverGames: async () => { throw error; } };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch(Array.from({ length: 4 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);

  await assert.doesNotReject(() => bot._dispatch(makeCallbackUpdate(7, 'menu:games')));

  assert.ok(fetch.calls.every(call => !String(call.body.text || '').includes('cookie details')));
});

test('session expiry during section discovery exits safely after coordinator cleanup', async () => {
  const error = Object.assign(new Error('Saved session expired'), { code: 'SESSION_EXPIRED' });
  const coordinator = { discoverSections: async () => { throw error; } };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch(Array.from({ length: 3 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_game', {
    games: [{ name: 'Game', url: 'https://tickets.mhaifafc.com/event/1' }],
  });

  await assert.doesNotReject(() => bot._dispatch(makeCallbackUpdate(7, 'game:0')));

  assert.ok(fetch.calls.every(call => !String(call.body.text || '').includes('Saved session expired')));
});

test('site errors during game discovery are rendered without internal details', async () => {
  const coordinator = { discoverGames: async () => { throw new Error('proxy password secret-value'); } };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch(Array.from({ length: 4 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);

  await bot._dispatch(makeCallbackUpdate(7, 'menu:games'));

  assert.doesNotMatch(fetch.calls.at(-1).body.text, /secret-value/);
  assert.deepEqual(
    fetch.calls.at(-1).body.reply_markup.inline_keyboard.flat().map(button => button.callback_data),
    ['games:retry', 'menu:home']
  );
});

test('games retry clears stale game choices before showing an empty-result prompt', async () => {
  const coordinator = { discoverGames: async () => [], getStatus: () => null };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch(Array.from({ length: 3 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_game', { games: [{ name: 'Old game', url: 'https://tickets.mhaifafc.com/game/old' }] });

  await bot._dispatch(makeCallbackUpdate(7, 'games:retry'));

  assert.equal(bot._getState('7').state, 'idle');
  assert.equal(fetch.calls.at(-1).body.text, 'לא נמצאו משחקים זמינים כרגע.');
});

test('menu home clears a pending setup safely', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['7'] });
  const fetch = makeFetch(Array.from({ length: 2 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_confirmation', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1', gameName: 'Game', sections: ['13'], quantity: 2,
  });

  await bot._dispatch(makeCallbackUpdate(7, 'menu:home'));

  assert.equal(bot._getState('7').state, 'idle');
  assert.match(fetch.calls.at(-1).body.text, /מה תרצה לעשות/);
});

test('free text cannot bypass buttons and redisplays the current menu', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['7'] });
  const fetch = makeFetch([{ ok: true, result: {} }, { ok: true, result: {} }]);
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_sections', { gameUrl: 'u', availableSections: ['13'], sections: [] });
  await bot._dispatch(makeTextUpdate(7, '999'));
  assert.equal(bot._getState('7').state, 'awaiting_sections');
  assert.deepEqual(bot._getState('7').data.sections, []);
  assert.match(fetch.calls[0].body.text, /מה תרצה לעשות/);

  bot._setState('7', 'awaiting_quantity', { gameUrl: 'u', sections: ['13'] });
  await bot._dispatch(makeTextUpdate(7, '4'));
  assert.equal(bot._getState('7').state, 'awaiting_quantity');
  assert.match(fetch.calls[1].body.text, /מה תרצה לעשות/);
});
