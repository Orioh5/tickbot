'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class UserSessionStore {
  constructor({ dataDir, encryptionKey }) {
    if (!encryptionKey) throw new Error('encryptionKey is required');
    this.dataDir = dataDir;
    this._key = crypto.scryptSync(encryptionKey, 'mhfc-session-salt', 32);
  }

  _filePath(userId) {
    const safe = String(userId).replace(/[^a-z0-9_-]/gi, '_');
    return path.join(this.dataDir, `session-${safe}.enc`);
  }

  save(userId, storageState) {
    const current = this.loadWithGeneration(userId);
    const generation = (current?.generation ?? 0) + 1;
    this._writeEncrypted(userId, {
      format: 'mhfc-session-v1',
      generation,
      storageState,
    });
    return generation;
  }

  _writeEncrypted(userId, value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._key, iv);
    const plain = JSON.stringify(value);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, tag, encrypted]).toString('base64');
    const filePath = this._filePath(userId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, payload, { mode: 0o600 });
  }

  _readEncrypted(userId) {
    const filePath = this._filePath(userId);
    if (!fs.existsSync(filePath)) return null;
    const buffer = Buffer.from(fs.readFileSync(filePath, 'utf8'), 'base64');
    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(12, 28);
    const encrypted = buffer.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this._key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  }

  loadWithGeneration(userId) {
    const value = this._readEncrypted(userId);
    if (value == null) return null;
    if (value.format === 'mhfc-session-v1' && Number.isSafeInteger(value.generation)) {
      return { generation: value.generation, storageState: value.storageState };
    }
    // Existing encrypted files contained storageState directly.
    return { generation: 0, storageState: value };
  }

  load(userId) {
    return this.loadWithGeneration(userId)?.storageState ?? null;
  }

  deleteIfGeneration(userId, generation) {
    const current = this.loadWithGeneration(userId);
    if (!current || current.generation !== generation) return false;
    this.delete(userId);
    return true;
  }

  delete(userId) {
    try { fs.unlinkSync(this._filePath(userId)); } catch (_) {}
  }
}

module.exports = UserSessionStore;
