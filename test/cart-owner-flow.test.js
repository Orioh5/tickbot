'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CartOwnerFlow = require('../bot/cart-owner-flow');

// ── Stubs ─────────────────────────────────────────────────────────────────────

function makeBot(callbackKey = 'candidate_0') {
  const sent = [];
  let registeredHandler = null;
  return {
    sent,
    sendMessage: async (chatId, text, extra) => {
      sent.push({ chatId, text, extra });
      // Auto-trigger the callback after sendMessage, simulating user picking
      if (registeredHandler && callbackKey !== null) {
        const h = registeredHandler;
        registeredHandler = null;
        setImmediate(() => h(callbackKey));
      }
    },
    registerCallbackHandler: (_nonce, _userId, handler) => {
      registeredHandler = handler;
      if (callbackKey === null) {
        // Simulate timeout
        setImmediate(() => handler(null));
      }
    },
    deregisterCallbackHandler: () => {},
  };
}

const candidates = [
  { key: 'candidate_0', name: 'Alice', identifier: 'id1', ticketKey: 'tk1' },
  { key: 'candidate_1', name: 'Bob',   identifier: 'id2', ticketKey: 'tk1' },
];

function makeOwnerBrowser({ required = true, applyResult = { status: 'assigned' } } = {}) {
  return {
    discover: async () => required ? { required: true, candidates } : { required: false },
    apply: async (_page, _candidate) => applyResult,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('returns not_required when no assignment needed', async () => {
  const flow = new CartOwnerFlow({
    telegramBotService: makeBot(),
    ownerBrowser: makeOwnerBrowser({ required: false }),
  });
  const result = await flow.run('1', 'chat1', {});
  assert.deepEqual(result, { status: 'not_required' });
});

test('sends candidate list to the correct chatId', async () => {
  const bot = makeBot('candidate_0');
  const flow = new CartOwnerFlow({ telegramBotService: bot, ownerBrowser: makeOwnerBrowser() });
  await flow.run('1', 'chat42', {}, 3);
  assert.equal(bot.sent[0].chatId, 'chat42');
  assert.match(bot.sent[0].text, /כרטיס 3/);
  const kb = bot.sent[0].extra.reply_markup.inline_keyboard;
  assert.equal(kb.length, 2);
  assert.equal(kb[0][0].text, 'Alice');
});

test('callback_data does not expose identifier or internal keys', async () => {
  const bot = makeBot('candidate_0');
  const flow = new CartOwnerFlow({ telegramBotService: bot, ownerBrowser: makeOwnerBrowser() });
  await flow.run('1', 'c', {});
  const kb = bot.sent[0].extra.reply_markup.inline_keyboard;
  for (const row of kb) {
    assert.doesNotMatch(row[0].callback_data, /id1|id2|tk1/);
  }
});

test('applies selected candidate and returns result', async () => {
  const applyResult = { status: 'assigned' };
  const flow = new CartOwnerFlow({
    telegramBotService: makeBot('candidate_1'),
    ownerBrowser: makeOwnerBrowser({ applyResult }),
  });
  const result = await flow.run('1', 'c', {});
  assert.deepEqual(result, applyResult);
});

test('returns timeout when handler receives null', async () => {
  const flow = new CartOwnerFlow({
    telegramBotService: makeBot(null), // null triggers timeout sim
    ownerBrowser: makeOwnerBrowser(),
  });
  const result = await flow.run('1', 'c', {});
  assert.deepEqual(result, { status: 'timeout' });
});

test('each run uses a unique nonce', async () => {
  const nonces = new Set();
  const bot = {
    sent: [],
    sendMessage: async (chatId, text, extra) => {
      const data = extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data || '';
      nonces.add(data.split(':')[0]);
      setImmediate(() => {}); // don't auto-trigger
    },
    registerCallbackHandler: (_nonce, _userId, handler) => setImmediate(() => handler(null)),
    deregisterCallbackHandler: () => {},
  };
  const flow = new CartOwnerFlow({ telegramBotService: bot, ownerBrowser: makeOwnerBrowser() });
  await Promise.all([flow.run('1', 'c', {}), flow.run('2', 'c', {})]);
  assert.equal(nonces.size, 2, 'nonces must differ across concurrent runs');
});
