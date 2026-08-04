const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingsStore, validateSettingsPatch } = require('../settings-store');

function withTempStore(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhfc-settings-test-'));
  const store = new SettingsStore({
    settingsPath: path.join(dataDir, 'settings.json'),
    encryptionSecret: 'test-encryption-key',
    env: {},
  });

  return Promise.resolve(run(store, dataDir)).finally(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
}

test('validates and normalizes a valid settings update', () => {
  const result = validateSettingsPatch({
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=1',
    sections: ['13', 14, '13'],
    intervalMs: 10000,
    desiredQuantity: 2,
    pauseOnHit: true,
  });

  assert.deepEqual(result.sections, ['13', '14']);
  assert.equal(result.intervalMs, 10000);
  assert.equal(result.desiredQuantity, 2);
});

test('rejects unsafe URLs and out-of-range monitoring values', () => {
  assert.throws(() => validateSettingsPatch({ url: 'file:///etc/passwd' }), /settings/i);
  assert.throws(() => validateSettingsPatch({ sections: ['13', '<script>'] }), /settings/i);
  assert.throws(() => validateSettingsPatch({ intervalMs: -1 }), /settings/i);
  assert.throws(() => validateSettingsPatch({ desiredQuantity: 99 }), /settings/i);
});

test('encrypts secrets at rest and decrypts them when loading', async () => {
  await withTempStore((store, dataDir) => {
    store.update({
      telegramToken: 'telegram-secret',
      loginPassword: 'login-secret',
      proxyPassword: 'proxy-secret',
    });

    const raw = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
    assert.match(raw, /"telegramToken": "enc:/);
    assert.doesNotMatch(raw, /telegram-secret|login-secret|proxy-secret/);

    const loaded = store.load();
    assert.equal(loaded.telegramToken, 'telegram-secret');
    assert.equal(loaded.loginPassword, 'login-secret');
    assert.equal(loaded.proxyPassword, 'proxy-secret');
  });
});

test('blank secret fields preserve saved values and public settings stay redacted', async () => {
  await withTempStore(store => {
    store.update({
      sections: ['13'],
      telegramToken: 'telegram-secret',
      loginPassword: 'login-secret',
      proxyPassword: 'proxy-secret',
    });
    store.update({
      sections: ['14'],
      telegramToken: '',
      loginPassword: '',
      proxyPassword: '',
    });

    const loaded = store.load();
    assert.equal(loaded.telegramToken, 'telegram-secret');
    assert.equal(loaded.loginPassword, 'login-secret');
    assert.equal(loaded.proxyPassword, 'proxy-secret');
    assert.deepEqual(loaded.sections, ['14']);

    const publicSettings = store.toPublic(loaded);
    assert.equal(publicSettings.telegramToken, '');
    assert.equal(publicSettings.loginPassword, '');
    assert.equal(publicSettings.proxyPassword, '');
    assert.equal(publicSettings.telegramTokenSet, true);
    assert.equal(publicSettings.loginPasswordSet, true);
    assert.equal(publicSettings.proxyPasswordSet, true);
  });
});

test('fails clearly instead of treating ciphertext as a secret when the key is wrong', async () => {
  await withTempStore((store, dataDir) => {
    store.update({ telegramToken: 'telegram-secret' });

    const wrongKeyStore = new SettingsStore({
      settingsPath: path.join(dataDir, 'settings.json'),
      encryptionSecret: 'wrong-key',
      env: {},
    });

    assert.throws(() => wrongKeyStore.load(), /check ENCRYPTION_KEY/);
  });
});

test('environment Telegram credentials stay fixed over saved dashboard values', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhfc-settings-env-test-'));
  try {
    const settingsPath = path.join(dataDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      telegramToken: '',
      telegramChatId: 'old-chat-id',
    }));

    const store = new SettingsStore({
      settingsPath,
      encryptionSecret: '',
      env: {
        TELEGRAM_TOKEN: 'fixed-token',
        TELEGRAM_CHAT_ID: 'fixed-chat-id',
      },
    });

    const loaded = store.load();
    assert.equal(loaded.telegramToken, 'fixed-token');
    assert.equal(loaded.telegramChatId, 'fixed-chat-id');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
