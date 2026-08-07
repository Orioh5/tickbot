'use strict';

const POLL_TIMEOUT_S = 25; // long-poll seconds
const STADIUM_CATALOG = require('./stadium-catalog');
const BotMenu = require('./bot-menu');

// Conversation states tracked per user
const STATE = {
  IDLE: 'idle',
  AWAITING_GAME: 'awaiting_game',
  AWAITING_SECTIONS: 'awaiting_sections',
  AWAITING_QUANTITY: 'awaiting_quantity',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  AWAITING_CHANGE_CONFIRMATION: 'awaiting_change_confirmation',
};

const ACTIONS = Object.freeze({
  'menu:login': 'login',
  'menu:games': 'games',
  'menu:status': 'status',
  'menu:stop': 'stop',
  'menu:change': 'change',
  'menu:home': 'home',
  'admin:invite': 'invite',
  'admin:users': 'users',
});

const ADMIN_ACTIONS = new Set(['invite', 'users']);
const LOG_SAFE_ERROR_CODES = new Set([
  'ABORT_ERR',
  'BOT_IDENTITY_UNAVAILABLE',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'MONITOR_BUSY',
  'SESSION_EXPIRED',
]);

function safeErrorCode(error, fallback) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return LOG_SAFE_ERROR_CODES.has(code) ? code : fallback;
}

class TelegramBotService {
  constructor({
    token,
    adminUserIds = [],
    userStore,
    secureLoginService,
    monitorCoordinator,
    userSessionStore,
    fetchImpl = fetch,
    now = () => Date.now(),
  }) {
    this.token = token;
    this.adminUserIds = new Set(adminUserIds.map(String));
    this.userStore = userStore;
    this.secureLoginService = secureLoginService;
    this.monitorCoordinator = monitorCoordinator;
    this.userSessionStore = userSessionStore;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.botUsername = null;

    this._offset = 0;
    this._running = false;
    this._stopController = null;

    // nonce → { userId, handler, timer }
    this._callbackHandlers = new Map();

    // userId → { state, data }
    this._convState = new Map();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start() {
    if (this._running) return;
    this._running = true;
    this._stopController = new AbortController();
    this._loop(this._stopController.signal).catch(() => {});
  }

  async initialize() {
    const identity = await this._call('getMe');
    if (typeof identity?.username !== 'string' || !identity.username) {
      throw new Error('Telegram getMe did not return a bot username');
    }
    this.setBotUsername(identity.username);
  }

  async initializeWithRetry({
    maxAttempts = 5,
    baseDelayMs = 500,
    sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.initialize();
        return;
      } catch (error) {
        if (attempt === maxAttempts) {
          throw Object.assign(new Error('Telegram bot identity is unavailable'), {
            code: safeErrorCode(error, 'BOT_IDENTITY_UNAVAILABLE'),
          });
        }
        await sleep(baseDelayMs * (2 ** (attempt - 1)));
      }
    }
  }

  setBotUsername(username) {
    this.botUsername = username;
  }

  async stop() {
    this._running = false;
    this._stopController?.abort();
  }

  // ── Public: send and callbacks ─────────────────────────────────────────────

  async sendMessage(chatId, text, extra = {}) {
    return this._call('sendMessage', { chat_id: chatId, text, ...extra });
  }

  async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return this._call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }

  async sendMarkdown(chatId, text, extra = {}) {
    return this._call('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
  }

  // Register a one-time callback handler for an inline-keyboard nonce.
  // handler(candidateKey) is called once when a matching callback arrives.
  // Automatically cleaned up after timeoutMs or when called.
  registerCallbackHandler(nonce, userId, handler, timeoutMs = 180_000) {
    const timer = setTimeout(() => {
      if (this._callbackHandlers.has(nonce)) {
        this._callbackHandlers.delete(nonce);
        handler(null); // null = timed out
      }
    }, timeoutMs);
    this._callbackHandlers.set(nonce, { userId: String(userId), handler, timer });
  }

  deregisterCallbackHandler(nonce) {
    const entry = this._callbackHandlers.get(nonce);
    if (entry) {
      clearTimeout(entry.timer);
      this._callbackHandlers.delete(nonce);
    }
  }

  // ── Conversation state helpers ─────────────────────────────────────────────

  _setState(userId, state, data = {}) {
    this._convState.set(String(userId), { state, data });
  }

  _getState(userId) {
    return this._convState.get(String(userId)) ?? { state: STATE.IDLE, data: {} };
  }

  _clearState(userId) {
    this._convState.delete(String(userId));
  }

  // ── Poll loop ──────────────────────────────────────────────────────────────

  async _loop(signal) {
    while (this._running && !signal.aborted) {
      try {
        const updates = await this._call('getUpdates', {
          offset: this._offset,
          timeout: POLL_TIMEOUT_S,
          allowed_updates: ['message', 'callback_query'],
        }, { signal });
        for (const update of updates) {
          this._offset = Math.max(this._offset, update.update_id + 1);
          await this._dispatch(update).catch(err => {
            console.error(
              `[TelegramBotService] dispatch failed code=${safeErrorCode(err, 'DISPATCH_FAILED')}.`
            );
          });
        }
      } catch (err) {
        if (signal.aborted || err.name === 'AbortError') break;
        // Brief back-off on network errors
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  async _dispatch(update) {
    if (update.callback_query) {
      await this._handleCallback(update.callback_query);
      return;
    }
    const msg = update.message;
    if (!msg?.text) return;

    const userId = String(msg.from?.id ?? '');
    const chatId = String(msg.chat?.id ?? '');
    const text = msg.text.trim();

    if (msg.chat?.type && msg.chat.type !== 'private') {
      await this.sendMessage(chatId, 'מטעמי פרטיות ואבטחה, יש להשתמש בבוט רק בצ׳אט פרטי.');
      return;
    }
    if (!this._isPrivateChatForUser(userId, msg.chat)) return;

    // Routing: commands take priority over conversation state
    const startMatch = text.match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]+))?$/);
    if (startMatch) {
      await this._cmdStart(userId, chatId, msg.from, startMatch[1]);
      return;
    }
    const command = text.match(/^\/([a-z]+)(?:@\w+)?(?:\s|$)/)?.[1];
    const action = {
      login: 'login',
      games: 'games',
      stop: 'stop',
      status: 'status',
      invite: 'invite',
      users: 'users',
    }[command];
    if (action && this._isUser(userId) && (!ADMIN_ACTIONS.has(action) || this._isAdmin(userId))) {
      await this._runAction(action, { userId, chatId, fromUser: msg.from });
      return;
    }
    if (text.startsWith('/revoke') && this._isAdmin(userId)) {
      await this._cmdRevoke(userId, chatId, text);
      return;
    }

    if (this._isUser(userId)) {
      await this.showMainMenu(userId, chatId);
      return;
    }

    // Unrecognized input
    if (!this._isUser(userId) && !this._isAdmin(userId)) {
      await this.sendMessage(chatId, 'לא ניתן להשתמש בבוט ללא הזמנה. שלח /start כדי להתחיל.');
    }
  }

  // ── Command handlers ───────────────────────────────────────────────────────

  async _cmdStart(userId, chatId, fromUser, inviteCode) {
    const user = this.userStore.getUser(userId);
    if (user) {
      await this.showMainMenu(userId, chatId);
      return;
    }
    if (this._isAdmin(userId)) {
      this.userStore.createUser({ telegramUserId: userId, username: fromUser?.username });
      await this.showMainMenu(userId, chatId);
      return;
    }
    if (!inviteCode) {
      await this.showMainMenu(userId, chatId);
      return;
    }
    try {
      const activeUsers = this.userStore.listUsers().filter(candidate => !candidate.revoked).length;
      if (activeUsers >= 10) throw new Error('המערכת הגיעה למגבלת 10 משתמשים פעילים');
      this.userStore.redeemInviteCode({
        code: inviteCode,
        userId,
        username: fromUser?.username,
        now: this.now(),
      });
      this._clearState(userId);
      await this.showMainMenu(userId, chatId);
    } catch (error) {
      this._clearState(userId);
      await this.sendMessage(chatId, '❌ קישור ההזמנה אינו תקין, פג תוקף או כבר נוצל.');
    }
  }

  _getMenuSnapshot(userId) {
    const user = this.userStore.getUser(userId);
    let hasSession = false;
    try {
      hasSession = Boolean(user && !user.revoked && this.userSessionStore?.load(userId));
    } catch (_) {
      console.error('[TelegramBotService] session lookup failed code=SESSION_LOOKUP_FAILED.');
    }
    const status = typeof this.monitorCoordinator?.getStatus === 'function'
      ? this.monitorCoordinator.getStatus(userId)
      : null;
    return BotMenu.snapshot({
      isRegistered: Boolean(user),
      isRevoked: Boolean(user?.revoked),
      isAdmin: this._isAdmin(userId),
      hasSession,
      monitorStatus: status ?? null,
    });
  }

  async showMainMenu(userId, chatId, suppliedSnapshot = null) {
    const current = suppliedSnapshot || this._getMenuSnapshot(userId);
    const menu = BotMenu.main(current);
    const text = !current.hasSession && current.isRegistered && !current.isRevoked &&
      current.lifecycle === 'idle'
      ? `${menu.text}\nלחץ על 🔐 התחבר כדי לחבר את החשבון שלך.`
      : menu.text;
    await this.sendMessage(chatId, text, { reply_markup: menu.reply_markup });
  }

  async _runAction(action, { userId, chatId, fromUser }) {
    const current = this._getMenuSnapshot(userId);
    const allowed = BotMenu.allowedActions(current);
    if (!allowed.has(action)) {
      await this.showMainMenu(userId, chatId, current);
      return;
    }

    switch (action) {
      case 'login':
        await this._cmdLogin(userId, chatId, fromUser);
        return;
      case 'games':
        await this._cmdGames(userId, chatId, fromUser);
        return;
      case 'change': {
        this._setState(userId, STATE.AWAITING_CHANGE_CONFIRMATION);
        await this._sendChangeConfirmationPrompt(chatId);
        return;
      }
      case 'status':
        await this._cmdStatus(userId, chatId, fromUser);
        return;
      case 'stop': {
        await this._cmdStop(userId, chatId, fromUser);
        return;
      }
      case 'home':
        this._clearState(userId);
        await this.showMainMenu(userId, chatId);
        return;
      case 'invite':
        await this._cmdInvite(userId, chatId, fromUser);
        return;
      case 'users':
        await this._cmdUsers(userId, chatId, fromUser);
        return;
      default:
        await this.showMainMenu(userId, chatId);
    }
  }

  async _cmdLogin(userId, chatId) {
    if (!this.secureLoginService) {
      await this.sendMessage(chatId, 'שגיאה: שירות ההתחברות אינו זמין.');
      return;
    }
    const link = this.secureLoginService.createLoginLink(userId);
    await this.sendMessage(chatId,
      `לחץ על הקישור להתחברות לחשבון מכבי חיפה שלך (תקף ל-10 דקות):\n${link}`
    );
  }

  async _cmdGames(userId, chatId) {
    if (!this.monitorCoordinator) {
      await this.sendMessage(chatId, 'שגיאה: מתאם ניטור אינו זמין.');
      return;
    }
    this._clearState(userId);
    await this.sendMessage(chatId, '⏳ מחפש משחקים זמינים...');
    try {
      const games = await this.monitorCoordinator.discoverGames(userId);
      if (!games.length) {
        await this.sendMessage(chatId, 'לא נמצאו משחקים זמינים כרגע.', {
          reply_markup: { inline_keyboard: [[
            { text: '🔄 בדוק שוב', callback_data: 'games:retry' },
            { text: '🏠 תפריט ראשי', callback_data: 'menu:home' },
          ]] },
        });
        return;
      }
      const keyboard = games.map((g, i) => [{ text: g.name, callback_data: `game:${i}` }]);
      this._setState(userId, STATE.AWAITING_GAME, { games });
      await this.sendMessage(chatId, 'בחר משחק:', {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      if (err?.code === 'SESSION_EXPIRED') return;
      await this.sendMessage(chatId, 'לא ניתן היה לחפש משחקים כרגע. אפשר לנסות שוב.', {
        reply_markup: { inline_keyboard: [[
          { text: '🔄 נסה שוב', callback_data: 'games:retry' },
          { text: '🏠 תפריט ראשי', callback_data: 'menu:home' },
        ]] },
      });
    }
  }

  async _cmdStop(userId, chatId) {
    if (this.monitorCoordinator?.getStatus(userId)) {
      await this.monitorCoordinator.stopMonitor(userId);
      this.userStore.setMonitoringActive(userId, false);
      await this.sendMessage(chatId, '⏹ ניטור הופסק.');
    } else {
      await this.sendMessage(chatId, 'אין ניטור פעיל.');
    }
  }

  async _cmdStatus(userId, chatId) {
    const status = this.monitorCoordinator?.getStatus(userId);
    if (!status) {
      await this.sendMessage(chatId, 'אין ניטור פעיל כרגע.');
      return;
    }
    const cfg = this.userStore.getMonitoringConfig(userId);
    await this.sendMessage(chatId,
      `📊 סטטוס: ${status.phase}\n` +
      `🎮 משחק: ${cfg?.game_url || '—'}\n` +
      `🪑 גושים: ${cfg?.sections?.join(', ') || '—'}`
    );
  }

  async _cmdInvite(userId, chatId) {
    if (!this.botUsername) {
      await this.sendMessage(chatId, 'שגיאה: זהות הבוט טרם אותחלה. נסה שוב בעוד רגע.');
      return;
    }
    const activeUsers = this.userStore.listUsers().filter(user => !user.revoked).length;
    if (activeUsers >= 10) {
      await this.sendMessage(chatId, 'הגעת למגבלת ה־MVP של 10 משתמשים פעילים.');
      return;
    }
    const crypto = require('crypto');
    const code = crypto.randomBytes(16).toString('hex').toUpperCase();
    this.userStore.createInviteCode({ code, createdBy: userId });
    const deepLink = `https://t.me/${this.botUsername}?start=${code}`;
    // Telegram auto-links plain URLs. Avoid Markdown here because bot
    // usernames may contain characters that Telegram's legacy Markdown
    // parser interprets as formatting and rejects.
    await this.sendMessage(chatId, `קישור הזמנה חדש: ${deepLink}\n(תקף ל־24 שעות ולשימוש אחד)`);
  }

  async _cmdUsers(userId, chatId) {
    const users = this.userStore.listUsers();
    if (!users.length) {
      await this.sendMessage(chatId, 'אין משתמשים רשומים.');
      return;
    }
    const lines = users.map(u =>
      `${u.revoked ? '🚫' : '✅'} ${u.username || '(ללא שם)'} — \`${u.telegram_user_id}\``
    );
    await this.sendMarkdown(chatId, `*משתמשים:*\n${lines.join('\n')}`);
  }

  async _cmdRevoke(userId, chatId, text) {
    const targetId = text.replace('/revoke', '').trim();
    if (!targetId) {
      await this.sendMessage(chatId, 'שימוש: /revoke <telegram_user_id>');
      return;
    }
    const target = this.userStore.getUser(targetId);
    if (!target) {
      await this.sendMessage(chatId, 'משתמש לא נמצא.');
      return;
    }
    // Authorization and durable access are revoked synchronously before any
    // browser teardown. A failed or hung close can retain capacity, never access.
    this.userStore.revokeUser(targetId);
    this.userStore.setMonitoringActive(targetId, false);
    this._deleteRevokedSession(targetId);
    this._clearState(targetId);
    for (const [nonce, entry] of this._callbackHandlers) {
      if (entry.userId === String(targetId)) this.deregisterCallbackHandler(nonce);
    }

    let teardown;
    try {
      teardown = this.monitorCoordinator?.stopMonitor(targetId);
    } catch (_) {
      console.error('[TelegramBotService] revoked monitor teardown failed code=MONITOR_STOP_FAILED.');
    }
    void Promise.resolve(teardown).catch(() => {
      console.error('[TelegramBotService] revoked monitor teardown failed code=MONITOR_STOP_FAILED.');
    });
    await this.sendMessage(chatId, `✅ גישה בוטלה למשתמש ${targetId}.`);
  }

  _deleteRevokedSession(userId) {
    if (!this.userSessionStore) return;
    try {
      if (typeof this.userSessionStore.loadWithGeneration === 'function' &&
          typeof this.userSessionStore.deleteIfGeneration === 'function') {
        const record = this.userSessionStore.loadWithGeneration(userId);
        if (record) this.userSessionStore.deleteIfGeneration(userId, record.generation);
        return;
      }
      this.userSessionStore.delete(userId);
    } catch (_) {
      // A corrupt encrypted file still carries access material; delete it by its
      // user-scoped path when generation inspection cannot be completed.
      try { this.userSessionStore.delete(userId); } catch (_) {}
      console.error('[TelegramBotService] revoked session cleanup failed code=SESSION_DELETE_FAILED.');
    }
  }

  async _startConfiguredMonitor(userId, chatId, data) {
    const {
      gameUrl,
      gameName = null,
      venueName = null,
      confidence = 'unknown',
      areas = [],
      sections,
      quantity,
    } = data;
    const eventMetadata = { gameName, venueName, confidence, areas };
    await this.sendMessage(
      chatId,
      `⏳ מתחיל ניטור: גושים ${sections.join(', ')}, ${quantity} כרטיסים...`
    ).catch(() => {
      console.error('[TelegramBotService] start notice failed code=TELEGRAM_SEND_FAILED.');
    });
    const result = await this.monitorCoordinator.startMonitor(userId, {
      gameUrl,
      gameName,
      venueName,
      confidence,
      areas,
      sections,
      quantity,
      chatId,
    });
    if (!this.monitorCoordinator.ownsPersistence) {
      try {
        this.userStore.setMonitoringConfig(userId, {
          gameUrl,
          sections,
          quantity,
          eventMetadata,
        });
        this.userStore.setMonitoringActive(userId, true);
      } catch (error) {
        try { await this.monitorCoordinator.stopMonitor(userId); } catch (_) {}
        try { this.userStore.setMonitoringActive(userId, false); } catch (_) {}
        throw Object.assign(new Error('Monitoring persistence failed'), {
          code: 'MONITOR_PERSISTENCE_FAILED',
          cause: error,
        });
      }
    }
    await this.sendMessage(chatId, result?.status === 'queued'
      ? '🕒 המעקב נשמר ונמצא בתור. הוא יתחיל אוטומטית כשיתפנה דפדפן.'
      : '✅ ניטור פעיל. תקבל התראה כשייפתחו כרטיסים.').catch(() => {
      console.error('[TelegramBotService] accepted monitor notice failed code=TELEGRAM_SEND_FAILED.');
    });
    return result;
  }

  // ── Callback query handler ─────────────────────────────────────────────────

  async _handleCallback(query) {
    const userId = String(query.from?.id ?? '');
    const chatId = String(query.message?.chat?.id ?? '');
    const data = String(query.data || '');

    await this._call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

    if (!this._isPrivateChatForUser(userId, query.message?.chat)) return;
    if (!this._isUser(userId)) return;

    if (data === 'noop') return;

    const action = ACTIONS[data];
    if (action) {
      await this._runAction(action, { userId, chatId, fromUser: query.from });
      return;
    }

    if (data === 'change:confirm') {
      const current = this._getState(userId);
      if (current.state !== STATE.AWAITING_CHANGE_CONFIRMATION) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      // Claim the confirmation before awaiting stop so a double-click cannot
      // stop newly-selected work after the first callback advances the flow.
      this._clearState(userId);
      await this.monitorCoordinator.stopMonitor(userId);
      this.userStore.setMonitoringActive(userId, false);
      await this._cmdGames(userId, chatId, query.from);
      return;
    }

    if (data === 'change:cancel') {
      const current = this._getState(userId);
      if (current.state !== STATE.AWAITING_CHANGE_CONFIRMATION) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      this._clearState(userId);
      await this.showMainMenu(userId, chatId);
      return;
    }

    // Game selection
    const gameMatch = data.match(/^game:(\d+)$/);
    if (gameMatch) {
      if (!this._configurationLifecycleIsIdle(userId)) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const { state, data: convData } = this._getState(userId);
      if (state !== STATE.AWAITING_GAME) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const game = convData.games?.[parseInt(gameMatch[1], 10)];
      if (!game) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      let eventMap;
      let dynamicMap = false;
      try {
        if (typeof this.monitorCoordinator.discoverEventMap === 'function') {
          dynamicMap = true;
          eventMap = await this.monitorCoordinator.discoverEventMap(userId, game);
        } else {
          const discovered = await this.monitorCoordinator.discoverSections(userId, game.url);
          eventMap = {
            eventId: null,
            gameName: game.name,
            gameUrl: game.url,
            venueName: null,
            confidence: 'partial',
            areas: discovered.map(section => ({
              ...section,
              label: String(section.label),
              components: [String(section.label)],
              available: true,
              source: 'dom',
            })),
          };
        }
      } catch (error) {
        if (error?.code === 'SESSION_EXPIRED') return;
        await this.sendMessage(chatId, 'לא ניתן היה לטעון את מפת הגושים כרגע.', {
          reply_markup: { inline_keyboard: [[
            { text: '🏠 תפריט ראשי', callback_data: 'menu:home' },
          ]] },
        });
        return;
      }
      const areas = eventMap.areas || [];
      if (!areas.length) {
        await this.sendMessage(chatId, `🎮 ${game.name}\nלא נמצאו גושים במפת המשחק כרגע.`);
        return;
      }
      const stateData = {
        gameUrl: eventMap.gameUrl || game.url,
        gameName: eventMap.gameName || game.name,
        venueName: eventMap.venueName || null,
        confidence: eventMap.confidence || 'partial',
        areas: dynamicMap ? areas : [],
        availableSections: areas.map(area => String(area.label)),
        sections: [],
      };
      this._setState(userId, STATE.AWAITING_SECTIONS, stateData);
      const sectionPrompt = await this.sendMessage(chatId, `🎮 ${game.name}\nבחר גושים ולחץ ✅ סיימתי:`, {
        reply_markup: { inline_keyboard: this._buildSectionsKeyboard(stateData) },
      });
      stateData.sectionMessageId = sectionPrompt?.message_id;
      this._setState(userId, STATE.AWAITING_SECTIONS, stateData);
      return;
    }

    const areaMatch = data.match(/^area:(\d+)$/);
    if (areaMatch) {
      if (!this._configurationLifecycleIsIdle(userId)) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const current = this._getState(userId);
      if (current.state !== STATE.AWAITING_SECTIONS) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      if (!Number.isInteger(current.data.sectionMessageId) || query.message?.message_id !== current.data.sectionMessageId) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const area = current.data.areas?.[Number(areaMatch[1])];
      if (!area) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const selected = new Set(current.data.sections || []);
      if (selected.has(area.label)) selected.delete(area.label);
      else selected.add(area.label);
      current.data.sections = [...selected];
      this._setState(userId, STATE.AWAITING_SECTIONS, current.data);
      await this.editMessageReplyMarkup(
        chatId,
        query.message?.message_id,
        { inline_keyboard: this._buildSectionsKeyboard(current.data) }
      ).catch(() => {
        console.error('[TelegramBotService] section keyboard edit failed code=TELEGRAM_EDIT_FAILED.');
      });
      return;
    }

    const sectionMatch = data.match(/^section:(\d+)$/);
    if (sectionMatch) {
      if (!this._configurationLifecycleIsIdle(userId)) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const current = this._getState(userId);
      if (current.state !== STATE.AWAITING_SECTIONS) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      if (!Number.isInteger(current.data.sectionMessageId) || query.message?.message_id !== current.data.sectionMessageId) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const label = sectionMatch[1];
      if (!current.data.availableSections?.includes(label)) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const selected = new Set(current.data.sections || []);
      if (selected.has(label)) selected.delete(label);
      else selected.add(label);
      current.data.sections = [...selected];
      this._setState(userId, STATE.AWAITING_SECTIONS, current.data);
      await this.editMessageReplyMarkup(
        chatId,
        query.message?.message_id,
        { inline_keyboard: this._buildSectionsKeyboard(current.data) }
      ).catch(() => {
        console.error('[TelegramBotService] section keyboard edit failed code=TELEGRAM_EDIT_FAILED.');
      });
      return;
    }

    if (data === 'sections_done') {
      if (!this._configurationLifecycleIsIdle(userId)) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const current = this._getState(userId);
      if (current.state !== STATE.AWAITING_SECTIONS) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      if (!Number.isInteger(current.data.sectionMessageId) || query.message?.message_id !== current.data.sectionMessageId) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      if (!current.data.sections?.length) {
        await this.sendMessage(chatId, 'בחר לפחות גוש אחד לפני שממשיכים.');
        return;
      }
      this._setState(userId, STATE.AWAITING_QUANTITY, current.data);
      await this._sendQuantityPrompt(chatId);
      return;
    }

    const quantityMatch = data.match(/^quantity:([1-4])$/);
    if (quantityMatch) {
      if (!this._configurationLifecycleIsIdle(userId)) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const current = this._getState(userId);
      if (current.state !== STATE.AWAITING_QUANTITY) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const confirmation = { ...current.data, quantity: Number(quantityMatch[1]) };
      this._setState(userId, STATE.AWAITING_CONFIRMATION, confirmation);
      await this._sendConfirmationPrompt(chatId, confirmation);
      return;
    }

    if (data === 'setup:confirm') {
      if (!this._configurationLifecycleIsIdle(userId)) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const current = this._getState(userId);
      if (current.state !== STATE.AWAITING_CONFIRMATION) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      // Claim this setup before awaiting the coordinator so repeat callbacks are stale.
      this._clearState(userId);
      try {
        await this._startConfiguredMonitor(userId, chatId, current.data);
      } catch (_error) {
        this._setState(userId, STATE.AWAITING_CONFIRMATION, current.data);
        await this._sendConfirmationPrompt(chatId, current.data, '❌ לא ניתן היה להתחיל את המעקב. אפשר לנסות שוב.');
      }
      return;
    }

    if (data === 'setup:back') {
      if (!this._configurationLifecycleIsIdle(userId)) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const current = this._getState(userId);
      if (current.state !== STATE.AWAITING_CONFIRMATION) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const { quantity, ...quantityData } = current.data;
      this._setState(userId, STATE.AWAITING_QUANTITY, quantityData);
      await this._sendQuantityPrompt(chatId);
      return;
    }

    if (data === 'setup:cancel') {
      const current = this._getState(userId);
      if (current.state !== STATE.AWAITING_CONFIRMATION) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      this._clearState(userId);
      await this.showMainMenu(userId, chatId);
      return;
    }

    if (data === 'games:retry') {
      await this._runAction('games', { userId, chatId, fromUser: query.from });
      return;
    }

    // Owner-selection or other registered nonces
    const parts = data.split(':');
    const nonce = parts[0];
    const candidateKey = parts.slice(1).join(':');
    const entry = this._callbackHandlers.get(nonce);
    if (entry && entry.userId === userId) {
      clearTimeout(entry.timer);
      this._callbackHandlers.delete(nonce);
      entry.handler(candidateKey);
      return;
    }
    await this.showMainMenu(userId, chatId);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _isUser(userId) {
    const user = this.userStore.getUser(userId);
    return user != null && !user.revoked;
  }

  _isAdmin(userId) {
    return this.adminUserIds.has(String(userId));
  }

  _isPrivateChatForUser(userId, chat) {
    return chat?.type === 'private' && String(chat.id) === String(userId);
  }

  _configurationLifecycleIsIdle(userId) {
    return this._getMenuSnapshot(userId).lifecycle === 'idle';
  }

  _buildSectionsKeyboard({ availableSections = [], sections = [], areas = [] }) {
    const selected = new Set(sections);
    if (areas.length) {
      const keyboard = [];
      for (let i = 0; i < areas.length; i += 2) {
        keyboard.push(areas.slice(i, i + 2).map((area, offset) => ({
          text: `${area.available ? '🟢' : '⚪'} ${selected.has(area.label) ? '✅ ' : ''}${area.label}`,
          callback_data: `area:${i + offset}`,
        })));
      }
      keyboard.push([{ text: `✅ סיימתי (${selected.size})`, callback_data: 'sections_done' }]);
      return keyboard;
    }
    const grouped = new Map();
    for (const label of availableSections) {
      const stand = Object.entries(STADIUM_CATALOG)
        .find(([, labels]) => labels.includes(label))?.[0] || 'גושים מהמפה';
      if (!grouped.has(stand)) grouped.set(stand, []);
      grouped.get(stand).push(label);
    }

    const keyboard = [];
    for (const [stand, labels] of grouped) {
      keyboard.push([{ text: `— ${stand} —`, callback_data: 'noop' }]);
      for (let i = 0; i < labels.length; i += 4) {
        keyboard.push(labels.slice(i, i + 4).map(label => ({
          text: `${selected.has(label) ? '✅ ' : ''}${label}`,
          callback_data: `section:${label}`,
        })));
      }
    }
    keyboard.push([{ text: `✅ סיימתי (${selected.size})`, callback_data: 'sections_done' }]);
    return keyboard;
  }

  async _sendQuantityPrompt(chatId) {
    await this.sendMessage(chatId, 'כמה כרטיסים לחפש?', {
      reply_markup: {
        inline_keyboard: [[1, 2, 3, 4].map(quantity => ({
          text: String(quantity),
          callback_data: `quantity:${quantity}`,
        }))],
      },
    });
  }

  async _sendConfirmationPrompt(chatId, confirmation, notice = '') {
    const prefix = notice ? `${notice}\n\n` : '';
    await this.sendMessage(chatId,
      `${prefix}סיכום הניטור:\n🎮 משחק: ${confirmation.gameName || 'המשחק שנבחר'}\n` +
      `🪑 גושים: ${confirmation.sections.join(', ')}\n🎟 כמות: ${confirmation.quantity}\n\nלאשר התחלת ניטור?`,
      {
        reply_markup: { inline_keyboard: [
          [{ text: '▶️ התחל מעקב', callback_data: 'setup:confirm' }],
          [
            { text: '⬅️ חזור', callback_data: 'setup:back' },
            { text: '❌ ביטול', callback_data: 'setup:cancel' },
          ],
        ] },
      }
    );
  }

  async _sendChangeConfirmationPrompt(chatId) {
    await this.sendMessage(chatId, 'שינוי הבחירה יפסיק את המעקב הפעיל. להמשיך?', {
      reply_markup: { inline_keyboard: [[
        { text: '✅ כן, שנה בחירה', callback_data: 'change:confirm' },
        { text: '❌ לא, השאר מעקב', callback_data: 'change:cancel' },
      ]] },
    });
  }

  async _call(method, body = {}, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }
    );
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(`Telegram ${method} failed: ${payload.description || response.status}`);
    }
    return payload.result;
  }
}

module.exports = TelegramBotService;
