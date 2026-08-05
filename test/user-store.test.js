'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const UserStore = require('../bot/user-store');

function makeStore() {
  return new UserStore({ dbPath: ':memory:' });
}

// ── Users ─────────────────────────────────────────────────────────────────────

test('getUser returns null for unknown user', () => {
  const store = makeStore();
  assert.equal(store.getUser('999'), null);
});

test('createUser and getUser round-trip', () => {
  const store = makeStore();
  store.createUser({ telegramUserId: '42', username: 'alice', now: 1000 });
  const user = store.getUser('42');
  assert.equal(user.telegram_user_id, '42');
  assert.equal(user.username, 'alice');
  assert.equal(user.revoked, 0);
  assert.equal(user.created_at, 1000);
});

test('createUser is idempotent (INSERT OR IGNORE)', () => {
  const store = makeStore();
  store.createUser({ telegramUserId: '42', username: 'alice' });
  store.createUser({ telegramUserId: '42', username: 'bob' });
  assert.equal(store.getUser('42').username, 'alice');
});

test('revokeUser sets revoked flag', () => {
  const store = makeStore();
  store.createUser({ telegramUserId: '7' });
  store.revokeUser('7');
  assert.equal(store.getUser('7').revoked, 1);
});

test('listUsers returns all users ordered by created_at', () => {
  const store = makeStore();
  store.createUser({ telegramUserId: 'b', now: 2000 });
  store.createUser({ telegramUserId: 'a', now: 1000 });
  const users = store.listUsers();
  assert.equal(users.length, 2);
  assert.equal(users[0].telegram_user_id, 'a');
  assert.equal(users[1].telegram_user_id, 'b');
});

// ── Invite codes ──────────────────────────────────────────────────────────────

test('getInviteCode returns null for unknown code', () => {
  const store = makeStore();
  assert.equal(store.getInviteCode('NOPE'), null);
});

test('redeemInviteCode creates user and marks code used', () => {
  const store = makeStore();
  store.createInviteCode({ code: 'ABCD', createdBy: 'admin', now: 100 });
  store.redeemInviteCode({ code: 'ABCD', userId: '55', username: 'eve', now: 200 });
  const invite = store.getInviteCode('ABCD');
  assert.equal(invite.used_by, '55');
  const user = store.getUser('55');
  assert.equal(user.username, 'eve');
  assert.equal(user.invited_by, 'admin');
});

test('redeemInviteCode throws on unknown code', () => {
  const store = makeStore();
  assert.throws(() => store.redeemInviteCode({ code: 'BAD', userId: '1' }), /Invalid invite code/);
});

test('redeemInviteCode throws on already-used code', () => {
  const store = makeStore();
  store.createInviteCode({ code: 'X', createdBy: 'admin' });
  store.redeemInviteCode({ code: 'X', userId: '1' });
  assert.throws(() => store.redeemInviteCode({ code: 'X', userId: '2' }), /already used/);
});

// ── Login tokens ──────────────────────────────────────────────────────────────

test('saveLoginToken and getLoginToken round-trip', () => {
  const store = makeStore();
  store.saveLoginToken({ tokenHash: 'hash1', userId: '99', expiresAt: 9999 });
  const token = store.getLoginToken('hash1');
  assert.equal(token.user_id, '99');
  assert.equal(token.expires_at, 9999);
  assert.equal(token.used, 0);
});

test('markLoginTokenUsed sets used flag', () => {
  const store = makeStore();
  store.saveLoginToken({ tokenHash: 'h2', userId: '1', expiresAt: 9999 });
  store.markLoginTokenUsed('h2');
  assert.equal(store.getLoginToken('h2').used, 1);
});

// ── Monitoring config ─────────────────────────────────────────────────────────

test('getMonitoringConfig returns null for unconfigured user', () => {
  const store = makeStore();
  assert.equal(store.getMonitoringConfig('42'), null);
});

test('setMonitoringConfig and getMonitoringConfig round-trip', () => {
  const store = makeStore();
  store.setMonitoringConfig('42', { gameUrl: 'https://example.com/game', sections: ['13', '14'], quantity: 2 });
  const cfg = store.getMonitoringConfig('42');
  assert.equal(cfg.game_url, 'https://example.com/game');
  assert.deepEqual(cfg.sections, ['13', '14']);
  assert.equal(cfg.quantity, 2);
});

test('setMonitoringConfig upserts on second call', () => {
  const store = makeStore();
  store.setMonitoringConfig('1', { gameUrl: 'https://a.com', sections: ['1'] });
  store.setMonitoringConfig('1', { gameUrl: 'https://b.com', sections: ['2', '3'], quantity: 3 });
  const cfg = store.getMonitoringConfig('1');
  assert.equal(cfg.game_url, 'https://b.com');
  assert.deepEqual(cfg.sections, ['2', '3']);
});

test('setMonitoringActive sets active flag', () => {
  const store = makeStore();
  store.setMonitoringConfig('5', { gameUrl: 'u', sections: [] });
  store.setMonitoringActive('5', true);
  assert.equal(store.getMonitoringConfig('5').active, 1);
  store.setMonitoringActive('5', false);
  assert.equal(store.getMonitoringConfig('5').active, 0);
});

test('listActiveMonitoring returns only active configurations', () => {
  const store = new UserStore();
  store.setMonitoringConfig('1', { gameUrl: 'https://game/1', sections: ['13'], quantity: 2 });
  store.setMonitoringConfig('2', { gameUrl: 'https://game/2', sections: ['14'], quantity: 1 });
  store.setMonitoringActive('1', true);
  const active = store.listActiveMonitoring();
  assert.equal(active.length, 1);
  assert.equal(active[0].telegram_user_id, '1');
  assert.deepEqual(active[0].sections, ['13']);
});
