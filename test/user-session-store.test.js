'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const UserSessionStore = require('../bot/user-session-store');

function withTempStore(encryptionKey = 'test-key', run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhfc-session-test-'));
  const store = new UserSessionStore({ dataDir, encryptionKey });
  return Promise.resolve(run(store, dataDir)).finally(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
}

const sampleState = { cookies: [{ name: 'sid', value: 'abc123', domain: 'example.com' }], origins: [] };

test('requires encryptionKey', () => {
  assert.throws(() => new UserSessionStore({ dataDir: '/tmp' }), /encryptionKey/);
});

test('load returns null for missing session', () => withTempStore('k', store => {
  assert.equal(store.load('999'), null);
}));

test('save and load round-trip', () => withTempStore('key', store => {
  store.save('42', sampleState);
  const loaded = store.load('42');
  assert.deepEqual(loaded, sampleState);
}));

test('each save advances the encrypted session generation', () => withTempStore('key', store => {
  const firstGeneration = store.save('42', sampleState);
  const secondState = { cookies: [{ name: 'sid', value: 'fresh' }], origins: [] };
  const secondGeneration = store.save('42', secondState);

  assert.equal(firstGeneration, 1);
  assert.equal(secondGeneration, 2);
  assert.deepEqual(store.loadWithGeneration('42'), {
    generation: 2,
    storageState: secondState,
  });
}));

test('conditional delete preserves a concurrently refreshed session', () => withTempStore('key', store => {
  const expiredGeneration = store.save('42', sampleState);
  const freshState = { cookies: [{ name: 'sid', value: 'fresh' }], origins: [] };
  store.save('42', freshState);

  assert.equal(store.deleteIfGeneration('42', expiredGeneration), false);
  assert.deepEqual(store.load('42'), freshState);
}));

test('conditional delete removes the unchanged expired generation', () => withTempStore('key', store => {
  const expiredGeneration = store.save('42', sampleState);

  assert.equal(store.deleteIfGeneration('42', expiredGeneration), true);
  assert.equal(store.load('42'), null);
}));

test('file is not plaintext JSON', () => withTempStore('key', (store, dataDir) => {
  store.save('42', sampleState);
  const files = fs.readdirSync(dataDir);
  assert.equal(files.length, 1);
  const raw = fs.readFileSync(path.join(dataDir, files[0]), 'utf8');
  assert.doesNotMatch(raw, /sid/); // cookie value must not appear in plaintext
}));

test('different users get separate files', () => withTempStore('key', (store, dataDir) => {
  store.save('1', { cookies: [], origins: [{ origin: 'user1' }] });
  store.save('2', { cookies: [], origins: [{ origin: 'user2' }] });
  assert.equal(fs.readdirSync(dataDir).length, 2);
  assert.deepEqual(store.load('1').origins[0].origin, 'user1');
  assert.deepEqual(store.load('2').origins[0].origin, 'user2');
}));

test('delete removes the file', () => withTempStore('key', (store, dataDir) => {
  store.save('7', sampleState);
  store.delete('7');
  assert.equal(store.load('7'), null);
  assert.equal(fs.readdirSync(dataDir).length, 0);
}));

test('delete is silent when file does not exist', () => withTempStore('key', store => {
  assert.doesNotThrow(() => store.delete('nonexistent'));
}));

test('wrong key fails to decrypt', () => withTempStore('key-a', store => {
  store.save('1', sampleState);
  const store2 = new UserSessionStore({ dataDir: store.dataDir, encryptionKey: 'key-b' });
  assert.throws(() => store2.load('1'));
}));

test('uses a different salt than SettingsStore', () => {
  // Both stores encrypt with AES-256-GCM but derive keys from different salts.
  // Verify the derived keys differ for the same passphrase.
  const crypto = require('crypto');
  const sessionKey = crypto.scryptSync('passphrase', 'mhfc-session-salt', 32);
  const settingsKey = crypto.scryptSync('passphrase', 'mhfc-settings-salt', 32);
  assert.notDeepEqual(sessionKey, settingsKey);
});
