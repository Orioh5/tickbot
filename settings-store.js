const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET_FIELDS = ['telegramToken', 'loginPassword', 'proxyPassword'];
const ALLOWED_FIELDS = new Set([
  'url', 'sections', 'customSections', 'intervalMs', 'pauseOnHit',
  'telegramToken', 'telegramChatId', 'loginUsername', 'loginPassword', 'loginUrl',
  'headful', 'proxyServer', 'proxyUsername', 'proxyPassword',
  'autoPurchase', 'desiredQuantity',
]);

class SettingsValidationError extends Error {
  constructor(message) {
    super(`Invalid settings: ${message}`);
    this.name = 'SettingsValidationError';
  }
}

function defaultSettings(env = process.env) {
  return {
    url: '',
    sections: [],
    intervalMs: 10000,
    pauseOnHit: true,
    telegramToken: env.TELEGRAM_TOKEN || '',
    telegramChatId: env.TELEGRAM_CHAT_ID || '',
    loginUsername: env.LOGIN_USERNAME || '',
    loginPassword: env.LOGIN_PASSWORD || '',
    loginUrl: 'https://auth.mhaifafc.com/',
    headful: false,
    proxyServer: '',
    proxyUsername: '',
    proxyPassword: '',
    autoPurchase: false,
    desiredQuantity: 1,
  };
}

function requireString(value, field, maxLength = 2000) {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new SettingsValidationError(`${field} must be a string of at most ${maxLength} characters`);
  }
  return value;
}

function validateUrl(value, field, allowedProtocols, allowedHost) {
  const stringValue = requireString(value, field);
  if (!stringValue) return stringValue;

  let parsed;
  try {
    parsed = new URL(stringValue);
  } catch (_) {
    throw new SettingsValidationError(`${field} must be a valid URL`);
  }

  if (!allowedProtocols.includes(parsed.protocol) || (allowedHost && parsed.hostname !== allowedHost)) {
    throw new SettingsValidationError(`${field} is not allowed`);
  }
  return parsed.toString();
}

function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new SettingsValidationError('request body must be an object');
  }

  const unknown = Object.keys(patch).filter(field => !ALLOWED_FIELDS.has(field));
  if (unknown.length) {
    throw new SettingsValidationError(`unknown fields: ${unknown.join(', ')}`);
  }

  const out = { ...patch };

  if ('url' in out) {
    out.url = validateUrl(out.url, 'url', ['https:'], 'tickets.mhaifafc.com');
  }
  if ('loginUrl' in out && out.loginUrl !== 'https://auth.mhaifafc.com/') {
    throw new SettingsValidationError('loginUrl cannot be changed');
  }
  if ('proxyServer' in out) {
    out.proxyServer = validateUrl(out.proxyServer, 'proxyServer', ['http:', 'https:', 'socks5:']);
  }
  if ('sections' in out) {
    if (!Array.isArray(out.sections) || out.sections.length > 100) {
      throw new SettingsValidationError('sections must be an array with at most 100 entries');
    }
    const sections = out.sections.map(section => String(section).trim());
    if (sections.some(section => !/^\d{1,6}$/.test(section))) {
      throw new SettingsValidationError('sections must contain numeric section IDs only');
    }
    out.sections = [...new Set(sections)];
  }
  if ('intervalMs' in out && (!Number.isInteger(out.intervalMs) || out.intervalMs < 1000 || out.intervalMs > 300000)) {
    throw new SettingsValidationError('intervalMs must be an integer between 1000 and 300000');
  }
  if ('desiredQuantity' in out && (!Number.isInteger(out.desiredQuantity) || out.desiredQuantity < 1 || out.desiredQuantity > 10)) {
    throw new SettingsValidationError('desiredQuantity must be an integer between 1 and 10');
  }

  for (const field of ['pauseOnHit', 'headful', 'autoPurchase']) {
    if (field in out && typeof out[field] !== 'boolean') {
      throw new SettingsValidationError(`${field} must be a boolean`);
    }
  }
  for (const field of [
    'customSections', 'telegramToken', 'telegramChatId', 'loginUsername',
    'loginPassword', 'proxyUsername', 'proxyPassword',
  ]) {
    if (field in out) out[field] = requireString(out[field], field);
  }

  return out;
}

class SettingsStore {
  constructor({ settingsPath, encryptionSecret, env = process.env }) {
    this.settingsPath = settingsPath;
    this.encryptionSecret = encryptionSecret || '';
    this.env = env;
  }

  _encryptionKey() {
    if (!this.encryptionSecret) return null;
    return crypto.scryptSync(this.encryptionSecret, 'mhfc-settings-salt', 32);
  }

  _encryptSecrets(settings) {
    const key = this._encryptionKey();
    if (!key) return settings;

    const out = { ...settings };
    for (const field of SECRET_FIELDS) {
      if (!out[field]) continue;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(out[field], 'utf8'), cipher.final()]);
      out[field] = `enc:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')}`;
    }
    return out;
  }

  _decryptSecrets(settings) {
    const key = this._encryptionKey();
    const out = { ...settings };

    for (const field of SECRET_FIELDS) {
      if (typeof out[field] !== 'string' || !out[field].startsWith('enc:')) continue;
      if (!key) throw new Error(`ENCRYPTION_KEY is required to decrypt ${field}`);

      try {
        const buffer = Buffer.from(out[field].slice(4), 'base64');
        const iv = buffer.subarray(0, 12);
        const tag = buffer.subarray(12, 28);
        const encrypted = buffer.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        out[field] = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
      } catch (_) {
        throw new Error(`Unable to decrypt ${field}; check ENCRYPTION_KEY`);
      }
    }
    return out;
  }

  load() {
    const settings = fs.existsSync(this.settingsPath)
      ? {
          ...defaultSettings(this.env),
          ...this._decryptSecrets(JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'))),
        }
      : defaultSettings(this.env);

    // Telegram credentials configured in the environment are deployment-level
    // constants and must not be replaced by stale or blank dashboard values.
    if (this.env.TELEGRAM_TOKEN) settings.telegramToken = this.env.TELEGRAM_TOKEN;
    if (this.env.TELEGRAM_CHAT_ID) settings.telegramChatId = this.env.TELEGRAM_CHAT_ID;

    return settings;
  }

  save(settings) {
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    const temporaryPath = `${this.settingsPath}.${process.pid}.tmp`;
    const serialized = JSON.stringify(this._encryptSecrets(settings), null, 2);

    try {
      fs.writeFileSync(temporaryPath, serialized, { mode: 0o600 });
      fs.renameSync(temporaryPath, this.settingsPath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch (_) {}
      throw error;
    }
  }

  update(patch) {
    const incoming = validateSettingsPatch(patch);
    for (const field of SECRET_FIELDS) {
      if (!incoming[field]) delete incoming[field];
    }
    const settings = { ...this.load(), ...incoming };
    this.save(settings);
    return settings;
  }

  toPublic(settings = this.load()) {
    const out = { ...settings };
    for (const field of SECRET_FIELDS) {
      out[`${field}Set`] = !!out[field];
      out[field] = '';
    }
    return out;
  }
}

module.exports = {
  SECRET_FIELDS,
  SettingsStore,
  SettingsValidationError,
  defaultSettings,
  validateSettingsPatch,
};
