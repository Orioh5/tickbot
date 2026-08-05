'use strict';

const crypto = require('crypto');

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

class SecureLoginService {
  constructor({ userStore, baseUrl, randomBytes = crypto.randomBytes, now = () => Date.now() }) {
    this.userStore = userStore;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.randomBytes = randomBytes;
    this.now = now;
  }

  createLoginLink(userId) {
    const rawToken = this.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = this.now() + TOKEN_TTL_MS;
    this.userStore.saveLoginToken({ tokenHash, userId: String(userId), expiresAt });
    return `${this.baseUrl}/bot-login?t=${rawToken}`;
  }

  // Validate without consuming (for GET — show form only if token is still valid).
  verifyToken(rawToken) {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const record = this.userStore.getLoginToken(tokenHash);
    if (!record) throw new Error('Invalid login link');
    if (record.used) throw new Error('Login link already used');
    if (this.now() > record.expires_at) throw new Error('Login link expired');
    return record.user_id;
  }

  redeemToken(rawToken) {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const record = this.userStore.getLoginToken(tokenHash);
    if (!record) throw new Error('Invalid login link');
    if (record.used) throw new Error('Login link already used');
    if (this.now() > record.expires_at) throw new Error('Login link expired');
    this.userStore.markLoginTokenUsed(tokenHash);
    return record.user_id;
  }
}

module.exports = SecureLoginService;
