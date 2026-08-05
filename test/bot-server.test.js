'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginNotifier } = require('../bot/bot-server');

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
