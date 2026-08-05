'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const UserStore = require('../bot/user-store');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('creates the parent directory for a file-backed database', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhfc-user-store-'));
  const dbPath = path.join(root, 'nested', 'bot.db');
  try {
    const store = new UserStore({ dbPath });
    store.createUser({ telegramUserId: '1' });
    assert.ok(fs.existsSync(dbPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeStore() {
  return new UserStore({ dbPath: ':memory:' });
}

function createLegacyInviteDatabase(dbPath, codes) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE invite_codes (
      code       TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      used_by    TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  const insert = db.prepare('INSERT INTO invite_codes (code, created_by, created_at) VALUES (?, ?, ?)');
  for (const code of codes) insert.run(code, 'admin', 1);
  db.close();
}

function contendForInvite(dbPath, userId, barrier) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const UserStore = require(workerData.userStorePath);
      const barrier = new Int32Array(workerData.barrier);
      Atomics.add(barrier, 0, 1);
      Atomics.notify(barrier, 0);
      Atomics.wait(barrier, 1, 0);
      try {
        const store = new UserStore({ dbPath: workerData.dbPath });
        store.redeemInviteCode({ code: 'CONTEND', userId: workerData.userId, now: 2 });
        parentPort.postMessage({ ok: true, userId: workerData.userId });
      } catch (error) {
        parentPort.postMessage({ ok: false, message: error.message });
      }
    `, {
      eval: true,
      workerData: {
        dbPath,
        userId,
        barrier,
        userStorePath: path.join(__dirname, '..', 'bot', 'user-store.js'),
      },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

async function releaseContentionBarrier(barrier) {
  while (Atomics.load(barrier, 0) !== 2) {
    await new Promise(resolve => setImmediate(resolve));
  }
  Atomics.store(barrier, 1, 1);
  Atomics.notify(barrier, 1, 2);
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

test('expired invite cannot be redeemed', () => {
  const store = makeStore();
  store.createInviteCode({ code: 'ABC', createdBy: '1', expiresAt: 100 });
  assert.throws(() => store.redeemInviteCode({ code: 'ABC', userId: '2', now: 101 }), /expired/i);
  assert.equal(store.getUser('2'), null);
});

test('invite codes expire 24 hours after their creation by default', () => {
  const store = makeStore();
  store.createInviteCode({ code: 'DAY', createdBy: '1', now: 100 });
  assert.equal(store.getInviteCode('DAY').expires_at, 100 + (24 * 60 * 60 * 1000));
});

test('invite code storage retains only a hash of the redeemable code', () => {
  const store = makeStore();
  store.createInviteCode({ code: 'SECRET-CODE', createdBy: '1' });
  const stored = store.db.prepare('SELECT code FROM invite_codes').get();
  assert.notEqual(stored.code, 'SECRET-CODE');
  assert.equal(stored.code.length, 64);
});

test('migrates a legacy file-backed invite database with expiry and hashed codes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhfc-legacy-invite-'));
  const dbPath = path.join(root, 'bot.db');
  try {
    createLegacyInviteDatabase(dbPath, ['LEGACY']);
    const store = new UserStore({ dbPath });
    const columns = store.db.prepare('PRAGMA table_info(invite_codes)').all();
    const stored = store.db.prepare('SELECT code, expires_at FROM invite_codes').get();

    assert.ok(columns.some(column => column.name === 'expires_at'));
    assert.equal(stored.code.length, 64);
    assert.equal(stored.expires_at, null);
    assert.equal(store.getInviteCode('LEGACY').created_by, 'admin');
    assert.equal(store.db.prepare("SELECT value FROM schema_metadata WHERE key = 'invite_code_hashing'").get().value, 'sha256');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed legacy hash migration rolls back all code updates and its marker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhfc-invite-migration-'));
  const dbPath = path.join(root, 'bot.db');
  try {
    createLegacyInviteDatabase(dbPath, ['FIRST', 'SECOND']);

    assert.throws(() => new UserStore({
      dbPath,
      migrationHook: ({ index }) => {
        if (index === 0) throw new Error('injected migration failure');
      },
    }), /injected migration failure/);

    const db = new DatabaseSync(dbPath);
    const codes = db.prepare('SELECT code FROM invite_codes ORDER BY code').all().map(row => row.code);
    assert.deepEqual(codes, ['FIRST', 'SECOND']);
    assert.equal(db.prepare("SELECT value FROM schema_metadata WHERE key = 'invite_code_hashing'").get(), undefined);
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two file-backed store connections contending for one invite allow only one redemption', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhfc-invite-contention-'));
  const dbPath = path.join(root, 'bot.db');
  try {
    const store = new UserStore({ dbPath });
    store.createInviteCode({ code: 'CONTEND', createdBy: 'admin', now: 1, expiresAt: 10_000 });
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const first = contendForInvite(dbPath, 'first', barrier);
    const second = contendForInvite(dbPath, 'second', barrier);
    await releaseContentionBarrier(new Int32Array(barrier));
    const results = await Promise.all([first, second]);

    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => !result.ok).length, 1);
    const winner = results.find(result => result.ok).userId;
    assert.equal(store.getInviteCode('CONTEND').used_by, winner);
    assert.ok(store.getUser(winner));
    assert.equal(store.listUsers().filter(user => ['first', 'second'].includes(user.telegram_user_id)).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
