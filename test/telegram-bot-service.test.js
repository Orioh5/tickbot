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
      chat: { id: userId },
      text,
    },
  };
}

function makeCallbackUpdate(userId, data, updateId = 2) {
  return {
    update_id: updateId,
    callback_query: {
      id: 'cq1',
      from: { id: userId },
      message: { chat: { id: userId } },
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
  const botFactory = (fetchImpl) => new TelegramBotService({
    token: 'test-token',
    adminUserIds,
    userStore: store,
    secureLoginService,
    monitorCoordinator,
    userSessionStore,
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
  });

  await bot._dispatch(makeCallbackUpdate(7, 'section:13'));
  await bot._dispatch(makeCallbackUpdate(7, 'sections_done'));

  const keyboard = fetch.calls.at(-1).body.reply_markup.inline_keyboard.flat();
  assert.deepEqual(keyboard.map(button => button.callback_data), ['quantity:1', 'quantity:2', 'quantity:3', 'quantity:4']);
});

test('quantity callback reports queued monitoring accurately', async () => {
  const coordinator = {
    startMonitor: async () => ({ status: 'queued' }),
  };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch([
    { ok: true, result: {} },
    { ok: true, result: {} },
    { ok: true, result: {} },
  ]);
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_quantity', { gameUrl: 'u', sections: ['13'] });
  await bot._dispatch(makeCallbackUpdate(7, 'quantity:2'));
  assert.match(fetch.calls.at(-1).body.text, /בתור/);
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
