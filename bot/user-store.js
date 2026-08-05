'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class UserStore {
  constructor({ dbPath = ':memory:' } = {}) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
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
    `);

    const inviteColumns = this.db.prepare('PRAGMA table_info(invite_codes)').all();
    if (!inviteColumns.some(column => column.name === 'expires_at')) {
      this.db.exec('ALTER TABLE invite_codes ADD COLUMN expires_at INTEGER');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const hashMigration = this.db.prepare("SELECT value FROM schema_metadata WHERE key = 'invite_code_hashing'").get();
    if (!hashMigration) {
      const legacyInviteCodes = this.db.prepare('SELECT code FROM invite_codes').all();
      const updateInviteCode = this.db.prepare('UPDATE invite_codes SET code = ? WHERE code = ?');
      for (const invite of legacyInviteCodes) {
        updateInviteCode.run(this._hashInviteCode(invite.code), invite.code);
      }
      this.db.prepare("INSERT INTO schema_metadata (key, value) VALUES ('invite_code_hashing', 'sha256')").run();
    }

    this._stmts = {
      insertUser:         this.db.prepare('INSERT OR IGNORE INTO users (telegram_user_id, username, invited_by, created_at) VALUES (?, ?, ?, ?)'),
      getUser:            this.db.prepare('SELECT * FROM users WHERE telegram_user_id = ?'),
      revokeUser:         this.db.prepare('UPDATE users SET revoked = 1 WHERE telegram_user_id = ?'),
      listUsers:          this.db.prepare('SELECT * FROM users ORDER BY created_at ASC'),
      insertInvite:       this.db.prepare('INSERT INTO invite_codes (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)'),
      getInvite:          this.db.prepare('SELECT * FROM invite_codes WHERE code = ?'),
      markInviteUsed:     this.db.prepare('UPDATE invite_codes SET used_by = ? WHERE code = ? AND used_by IS NULL AND expires_at >= ?'),
      insertToken:        this.db.prepare('INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
      getToken:           this.db.prepare('SELECT * FROM login_tokens WHERE token_hash = ?'),
      markTokenUsed:      this.db.prepare('UPDATE login_tokens SET used = 1 WHERE token_hash = ?'),
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
    this._stmts.revokeUser.run(String(telegramUserId));
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

  listActiveMonitoring() {
    return this._stmts.listActiveMonitoring.all().map(row => ({
      ...row,
      sections: JSON.parse(row.sections || '[]'),
    }));
  }
}

module.exports = UserStore;
