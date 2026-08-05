'use strict';

const { DatabaseSync } = require('node:sqlite');

class UserStore {
  constructor({ dbPath = ':memory:' } = {}) {
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
        created_at  INTEGER NOT NULL
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

    this._stmts = {
      insertUser:         this.db.prepare('INSERT OR IGNORE INTO users (telegram_user_id, username, invited_by, created_at) VALUES (?, ?, ?, ?)'),
      getUser:            this.db.prepare('SELECT * FROM users WHERE telegram_user_id = ?'),
      revokeUser:         this.db.prepare('UPDATE users SET revoked = 1 WHERE telegram_user_id = ?'),
      listUsers:          this.db.prepare('SELECT * FROM users ORDER BY created_at ASC'),
      insertInvite:       this.db.prepare('INSERT INTO invite_codes (code, created_by, created_at) VALUES (?, ?, ?)'),
      getInvite:          this.db.prepare('SELECT * FROM invite_codes WHERE code = ?'),
      markInviteUsed:     this.db.prepare('UPDATE invite_codes SET used_by = ? WHERE code = ?'),
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

  createInviteCode({ code, createdBy, now = Date.now() }) {
    this._stmts.insertInvite.run(code, String(createdBy), now);
  }

  getInviteCode(code) {
    return this._stmts.getInvite.get(code) ?? null;
  }

  redeemInviteCode({ code, userId, username = null, now = Date.now() }) {
    const invite = this.getInviteCode(code);
    if (!invite) throw new Error('Invalid invite code');
    if (invite.used_by != null) throw new Error('Invite code already used');
    const uid = String(userId);
    this._stmts.markInviteUsed.run(uid, code);
    this.createUser({ telegramUserId: uid, username, invitedBy: invite.created_by, now });
    return invite;
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
