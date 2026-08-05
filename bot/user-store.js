'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class UserStore {
  constructor({ dbPath = ':memory:', migrationHook = null } = {}) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this._migrationHook = migrationHook;
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_user_id TEXT PRIMARY KEY,
        username         TEXT,
        invited_by       TEXT,
        created_at       INTEGER NOT NULL,
        revoked          INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS invite_codes (
        code        TEXT PRIMARY KEY,
        created_by  TEXT NOT NULL,
        used_by     TEXT,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used       INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS user_monitoring (
        telegram_user_id TEXT PRIMARY KEY,
        game_url         TEXT,
        sections         TEXT,
        quantity         INTEGER NOT NULL DEFAULT 1,
        active           INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS schema_metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Schema inspection and the migration marker must share the same write
    // transaction. A second process waits at BEGIN IMMEDIATE, then rechecks the
    // marker instead of hashing an already-migrated code a second time.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const inviteColumns = this.db.prepare('PRAGMA table_info(invite_codes)').all();
      if (!inviteColumns.some(column => column.name === 'expires_at')) {
        this.db.exec('ALTER TABLE invite_codes ADD COLUMN expires_at INTEGER');
      }
      const hashMigration = this.db
        .prepare("SELECT value FROM schema_metadata WHERE key = 'invite_code_hashing'")
        .get();
      if (!hashMigration) {
        const legacyInviteCodes = this.db.prepare('SELECT code FROM invite_codes').all();
        const updateInviteCode = this.db.prepare('UPDATE invite_codes SET code = ? WHERE code = ?');
        for (const [index, invite] of legacyInviteCodes.entries()) {
          updateInviteCode.run(this._hashInviteCode(invite.code), invite.code);
          this._migrationHook?.({ index });
        }
        this.db.prepare("INSERT INTO schema_metadata (key, value) VALUES ('invite_code_hashing', 'sha256')").run();
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    this._stmts = {
      insertUser:         this.db.prepare('INSERT OR IGNORE INTO users (telegram_user_id, username, invited_by, created_at) VALUES (?, ?, ?, ?)'),
      getUser:            this.db.prepare('SELECT * FROM users WHERE telegram_user_id = ?'),
      getActiveUser:      this.db.prepare('SELECT * FROM users WHERE telegram_user_id = ? AND revoked = 0'),
      markUserRevoked:    this.db.prepare('UPDATE users SET revoked = 1 WHERE telegram_user_id = ?'),
      invalidateUserTokens: this.db.prepare('UPDATE login_tokens SET used = 1 WHERE user_id = ? AND used = 0'),
      listUsers:          this.db.prepare('SELECT * FROM users ORDER BY created_at ASC'),
      insertInvite:       this.db.prepare('INSERT INTO invite_codes (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)'),
      getInvite:          this.db.prepare('SELECT * FROM invite_codes WHERE code = ?'),
      markInviteUsed:     this.db.prepare('UPDATE invite_codes SET used_by = ? WHERE code = ? AND used_by IS NULL AND expires_at >= ?'),
      insertToken:        this.db.prepare('INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
      getToken:           this.db.prepare('SELECT * FROM login_tokens WHERE token_hash = ?'),
      markTokenUsed:      this.db.prepare('UPDATE login_tokens SET used = 1 WHERE token_hash = ?'),
      redeemToken:        this.db.prepare(`
        UPDATE login_tokens
        SET used = 1
        WHERE token_hash = ?
          AND used = 0
          AND expires_at >= ?
          AND EXISTS (
            SELECT 1 FROM users
            WHERE users.telegram_user_id = login_tokens.user_id
              AND users.revoked = 0
          )
      `),
      upsertMonitoring:   this.db.prepare(`
        INSERT INTO user_monitoring (telegram_user_id, game_url, sections, quantity)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          game_url = excluded.game_url,
          sections = excluded.sections,
          quantity = excluded.quantity
      `),
      getMonitoring:      this.db.prepare('SELECT * FROM user_monitoring WHERE telegram_user_id = ?'),
      listActiveMonitoring: this.db.prepare('SELECT * FROM user_monitoring WHERE active = 1 ORDER BY telegram_user_id'),
      setActiveFlag:      this.db.prepare(`
        INSERT INTO user_monitoring (telegram_user_id, active)
        VALUES (?, ?)
        ON CONFLICT(telegram_user_id) DO UPDATE SET active = excluded.active
      `),
      upsertAcceptedMonitoring: this.db.prepare(`
        INSERT INTO user_monitoring (telegram_user_id, game_url, sections, quantity, active)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          game_url = excluded.game_url,
          sections = excluded.sections,
          quantity = excluded.quantity,
          active = 1
      `),
    };
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  createUser({ telegramUserId, username = null, invitedBy = null, now = Date.now() }) {
    this._stmts.insertUser.run(String(telegramUserId), username, invitedBy, now);
  }

  getUser(telegramUserId) {
    return this._stmts.getUser.get(String(telegramUserId)) ?? null;
  }

  revokeUser(telegramUserId) {
    const uid = String(telegramUserId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this._stmts.markUserRevoked.run(uid);
      this._stmts.invalidateUserTokens.run(uid);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listUsers() {
    return this._stmts.listUsers.all();
  }

  // ── Invite codes ───────────────────────────────────────────────────────────

  createInviteCode({ code, createdBy, expiresAt, now = Date.now() }) {
    const expiry = expiresAt ?? now + (24 * 60 * 60 * 1000);
    this._stmts.insertInvite.run(this._hashInviteCode(code), String(createdBy), now, expiry);
  }

  getInviteCode(code) {
    return this._stmts.getInvite.get(this._hashInviteCode(code)) ?? null;
  }

  redeemInviteCode({ code, userId, username = null, now = Date.now() }) {
    const uid = String(userId);
    const codeHash = this._hashInviteCode(code);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this._stmts.markInviteUsed.run(uid, codeHash, now);
      if (result.changes !== 1) throw this._classifyInviteFailure(codeHash, now, true);
      const invite = this._stmts.getInvite.get(codeHash);
      this._stmts.insertUser.run(uid, username, invite.created_by, now);
      this.db.exec('COMMIT');
      return invite;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  _classifyInviteFailure(code, now, isHash = false) {
    const invite = this._stmts.getInvite.get(isHash ? code : this._hashInviteCode(code));
    if (!invite) return new Error('Invalid invite code');
    if (invite.used_by != null) return new Error('Invite code already used');
    if (invite.expires_at == null || invite.expires_at < now) return new Error('Invite code expired');
    return new Error('Invalid invite code');
  }

  _hashInviteCode(code) {
    return crypto.createHash('sha256').update(String(code)).digest('hex');
  }

  // ── Login tokens ───────────────────────────────────────────────────────────

  saveLoginToken({ tokenHash, userId, expiresAt }) {
    this._stmts.insertToken.run(tokenHash, String(userId), expiresAt);
  }

  getLoginToken(tokenHash) {
    return this._stmts.getToken.get(tokenHash) ?? null;
  }

  markLoginTokenUsed(tokenHash) {
    this._stmts.markTokenUsed.run(tokenHash);
  }

  redeemLoginToken({ tokenHash, now = Date.now(), onAuthorized = null }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this._stmts.redeemToken.run(tokenHash, now);
      if (result.changes !== 1) throw this._classifyLoginTokenFailure(tokenHash, now);
      const record = this._stmts.getToken.get(tokenHash);
      const activeUser = this._stmts.getActiveUser.get(record.user_id);
      if (!activeUser) throw new Error('Login user is not active or unavailable');

      if (onAuthorized) {
        const callbackResult = onAuthorized(record.user_id);
        if (callbackResult && typeof callbackResult.then === 'function') {
          throw new Error('Authorized login persistence must be synchronous');
        }
      }

      this.db.exec('COMMIT');
      return record.user_id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  _classifyLoginTokenFailure(tokenHash, now) {
    const record = this._stmts.getToken.get(tokenHash);
    if (!record) return new Error('Invalid login link');
    if (record.used) return new Error('Login link already used');
    if (record.expires_at < now) return new Error('Login link expired');
    const activeUser = this._stmts.getActiveUser.get(record.user_id);
    if (!activeUser) return new Error('Login user is not active or unavailable');
    return new Error('Login link unavailable');
  }

  // ── Monitoring config ──────────────────────────────────────────────────────

  setMonitoringConfig(userId, { gameUrl, sections, quantity = 1 }) {
    this._stmts.upsertMonitoring.run(String(userId), gameUrl, JSON.stringify(sections), quantity);
  }

  getMonitoringConfig(userId) {
    const row = this._stmts.getMonitoring.get(String(userId));
    if (!row) return null;
    return { ...row, sections: JSON.parse(row.sections || '[]') };
  }

  setMonitoringActive(userId, active) {
    this._stmts.setActiveFlag.run(String(userId), active ? 1 : 0);
  }

  acceptMonitoring(userId, { gameUrl, sections, quantity = 1 }) {
    const uid = String(userId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this._stmts.getActiveUser.get(uid)) {
        throw new Error('Monitoring user is not active or unavailable');
      }
      this._stmts.upsertAcceptedMonitoring.run(
        uid,
        gameUrl,
        JSON.stringify(sections),
        quantity
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listActiveMonitoring() {
    return this._stmts.listActiveMonitoring.all().map(row => ({
      ...row,
      sections: JSON.parse(row.sections || '[]'),
    }));
  }
}

module.exports = UserStore;
