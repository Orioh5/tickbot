'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.APP_PASSWORD = 'test-password';
process.env.ENCRYPTION_KEY = 'test-encryption-key';
process.env.BOT_TOKEN = '';
process.env.TELEGRAM_TOKEN = '';

const { createApp, createDashboardOwnerSelector } = require('../server');

async function withServer(botServices, run) {
  const server = http.createServer(createApp({ botServices }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('Telegram webhook rejects requests without the configured secret', async () => {
  await withServer({
    telegramWebhook: { secret: 'right-secret', handleUpdate: async () => {} },
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update_id: 1 }),
    });

    assert.equal(response.status, 403);
  });
});

test('Telegram webhook acknowledges and dispatches an authenticated update', async () => {
  let received;
  let resolveDispatch;
  const dispatched = new Promise(resolve => { resolveDispatch = resolve; });
  await withServer({
    telegramWebhook: {
      secret: 'right-secret',
      handleUpdate: async update => {
        received = update;
        resolveDispatch();
      },
    },
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'right-secret',
      },
      body: JSON.stringify({ update_id: 42 }),
    });

    assert.equal(response.status, 200);
    await dispatched;
    assert.deepEqual(received, { update_id: 42 });
  });
});

test('dashboard owner selection uses the bot callback channel instead of Telegram polling', () => {
  const expected = { chooseOwner: async () => ({ status: 'selected', candidateKey: 'owner-1' }) };
  const calls = [];
  const selector = createDashboardOwnerSelector({
    createOwnerSelector: (...args) => {
      calls.push(args);
      return expected;
    },
  }, { telegramChatId: '42' });

  assert.equal(selector, expected);
  assert.deepEqual(calls, [['42', '42']]);
});
