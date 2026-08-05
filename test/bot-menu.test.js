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

test('every rendered user action is allowed by the same authoritative snapshot', () => {
  const snapshot = BotMenu.snapshot({
    isRegistered: true,
    hasSession: true,
    monitorStatus: { running: true, busy: true, phase: 'owner-selection' },
  });
  const menu = BotMenu.main(snapshot);
  const callbackToAction = {
    'menu:games': 'games',
    'menu:login': 'login',
    'menu:status': 'status',
    'menu:stop': 'stop',
    'menu:change': 'change',
  };

  assert.deepEqual(
    callbacks(menu).map(callback => callbackToAction[callback]).filter(Boolean),
    [...BotMenu.allowedActions(snapshot)].filter(action => action !== 'home')
  );
});

test('all active monitor phases suppress login and game selection consistently', () => {
  const phases = [
    'starting',
    'monitoring',
    'cart-interaction',
    'cart-verification',
    'owner-selection',
    'cart-ready',
    'cart-recovery',
  ];

  for (const phase of phases) {
    const snapshot = BotMenu.snapshot({
      isRegistered: true,
      hasSession: phase !== 'starting',
      monitorStatus: { running: true, busy: true, phase },
    });
    assert.equal(snapshot.lifecycle, 'active', phase);
    assert.deepEqual(callbacks(BotMenu.main(snapshot)), [
      'menu:status',
      'menu:stop',
      'menu:change',
    ], phase);
    assert.equal(BotMenu.allowedActions(snapshot).has('games'), false, phase);
    assert.equal(BotMenu.allowedActions(snapshot).has('login'), false, phase);
  }
});

test('queued, stopping, and unknown busy status are normalized before rendering', () => {
  const cases = [
    {
      status: { running: false, busy: true, phase: 'queued' },
      lifecycle: 'queued',
      expected: ['menu:status', 'menu:stop'],
    },
    {
      status: { running: false, busy: true, phase: 'stopping' },
      lifecycle: 'stopping',
      expected: ['menu:status'],
    },
    {
      status: { running: false, busy: true, phase: 'future-browser-phase' },
      lifecycle: 'active',
      expected: ['menu:status', 'menu:stop', 'menu:change'],
    },
  ];

  for (const { status, lifecycle, expected } of cases) {
    const snapshot = BotMenu.snapshot({
      isRegistered: true,
      hasSession: true,
      monitorStatus: status,
    });
    assert.equal(snapshot.lifecycle, lifecycle);
    assert.deepEqual(callbacks(BotMenu.main(snapshot)), expected);
  }
});
