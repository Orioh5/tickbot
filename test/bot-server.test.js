'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createLoginNotifier,
  parseBotMaxBrowsers,
  startOperationalBot,
} = require('../bot/bot-server');

test('login notifier sends the success continuation to the user with both buttons', async () => {
  const calls = [];
  const bot = {
    sendMessage: async (chatId, text, extra) => {
      calls.push({ chatId, text, extra });
    },
  };

  await createLoginNotifier(bot).loginSucceeded('42');

  assert.deepEqual(calls, [{
    chatId: '42',
    text: '✅ החשבון חובר בהצלחה.',
    extra: {
      reply_markup: {
        inline_keyboard: [[
          { text: '⚽ בחר משחק', callback_data: 'menu:games' },
          { text: '🏠 תפריט ראשי', callback_data: 'menu:home' },
        ]],
      },
    },
  }]);
});

test('BOT_MAX_BROWSERS accepts only a positive bounded integer', () => {
  assert.equal(parseBotMaxBrowsers(undefined), 3);
  assert.equal(parseBotMaxBrowsers('1'), 1);
  assert.equal(parseBotMaxBrowsers('32'), 32);

  for (const value of ['', '0', '-1', '1.5', '2x', 'NaN', '33', '999999']) {
    assert.throws(
      () => parseBotMaxBrowsers(value),
      /BOT_MAX_BROWSERS/,
      `value=${JSON.stringify(value)}`
    );
  }
});

test('restored monitors start only after bot identity and webhook registration', async () => {
  const order = [];
  let releaseIdentity;
  const identityReady = new Promise(resolve => { releaseIdentity = resolve; });
  const bot = {
    initializeWithRetry: async () => {
      order.push('identity');
      await identityReady;
    },
    startWebhook: async options => { order.push(['webhook', options]); },
  };
  const monitorCoordinator = {
    restoreActiveMonitors: async () => { order.push('restore'); },
  };

  const startup = startOperationalBot({
    bot,
    monitorCoordinator,
    webhookUrl: 'https://bot.example/telegram/webhook',
    webhookSecret: 'secret',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['identity']);

  releaseIdentity();
  await startup;
  assert.deepEqual(order, [
    'identity',
    ['webhook', { url: 'https://bot.example/telegram/webhook', secret: 'secret' }],
    'restore',
  ]);
});
