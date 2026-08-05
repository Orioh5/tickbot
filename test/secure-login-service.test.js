'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const UserStore = require('../bot/user-store');
const SecureLoginService = require('../bot/secure-login-service');

function makeService({ now = () => 1000, randomBytes } = {}) {
  const store = new UserStore();
  for (const userId of ['1', '7', '42', '99']) {
    store.createUser({ telegramUserId: userId });
  }
  const svc = new SecureLoginService({
    userStore: store,
    baseUrl: 'https://example.com',
    randomBytes: randomBytes ?? (n => Buffer.alloc(n, 0xab)),
    now,
  });
  return { store, svc };
}

test('createLoginLink returns URL with hex token', () => {
  const { svc } = makeService();
  const link = svc.createLoginLink('42');
  assert.match(link, /^https:\/\/example\.com\/bot-login\?t=[0-9a-f]+$/);
});

test('createLoginLink strips trailing slash from baseUrl', () => {
  const store = new UserStore();
  const svc = new SecureLoginService({ userStore: store, baseUrl: 'https://example.com/' });
  const link = svc.createLoginLink('1');
  assert.match(link, /^https:\/\/example\.com\/bot-login/);
});

test('createLoginLink stores hash, not raw token', () => {
  let captured;
  const { store, svc } = makeService({
    randomBytes: n => { captured = crypto.randomBytes(n); return captured; },
  });
  svc.createLoginLink('7');
  const rawToken = captured.toString('hex');
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const record = store.getLoginToken(hash);
  assert.ok(record, 'token record should exist under hash');
  // raw token must NOT appear as a key
  assert.equal(store.getLoginToken(rawToken), null);
});

test('redeemToken returns userId and marks token used', () => {
  const { svc } = makeService();
  const link = svc.createLoginLink('99');
  const rawToken = new URL(link).searchParams.get('t');
  const userId = svc.redeemToken(rawToken);
  assert.equal(userId, '99');
});

test('redeemToken throws on second use', () => {
  const { svc } = makeService();
  const link = svc.createLoginLink('1');
  const rawToken = new URL(link).searchParams.get('t');
  svc.redeemToken(rawToken);
  assert.throws(() => svc.redeemToken(rawToken), /already used/);
});

test('redeemToken throws on invalid token', () => {
  const { svc } = makeService();
  assert.throws(() => svc.redeemToken('notavalidtoken'), /Invalid login link/);
});

test('verifyToken peeks without consuming', () => {
  const { svc } = makeService();
  const link = svc.createLoginLink('1');
  const rawToken = new URL(link).searchParams.get('t');
  svc.verifyToken(rawToken); // peek
  // token should still be redeemable
  const userId = svc.redeemToken(rawToken);
  assert.equal(userId, '1');
});

test('verifyToken throws on already-used token', () => {
  const { svc } = makeService();
  const link = svc.createLoginLink('1');
  const rawToken = new URL(link).searchParams.get('t');
  svc.redeemToken(rawToken);
  assert.throws(() => svc.verifyToken(rawToken), /already used/);
});

test('redeemToken throws on expired token', () => {
  let clock = 0;
  const { svc } = makeService({ now: () => clock });
  const link = svc.createLoginLink('1');
  const rawToken = new URL(link).searchParams.get('t');
  clock = 10 * 60 * 1000 + 1; // past TTL
  assert.throws(() => svc.redeemToken(rawToken), /expired/);
});

test('verifyToken and redeemToken reject links after their user is revoked', () => {
  const { store, svc } = makeService();
  const rawToken = new URL(svc.createLoginLink('7')).searchParams.get('t');

  store.revokeUser('7');

  assert.throws(() => svc.verifyToken(rawToken), /used|active|unavailable/i);
  assert.throws(() => svc.redeemToken(rawToken), /used|active|unavailable/i);
});

test('completeLogin persists only while the token user remains active', () => {
  const { store, svc } = makeService();
  const rawToken = new URL(svc.createLoginLink('7')).searchParams.get('t');
  const savedFor = [];

  store.revokeUser('7');

  assert.throws(
    () => svc.completeLogin(rawToken, userId => savedFor.push(userId)),
    /used|active|unavailable/i
  );
  assert.deepEqual(savedFor, []);
});
