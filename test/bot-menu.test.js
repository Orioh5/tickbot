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
