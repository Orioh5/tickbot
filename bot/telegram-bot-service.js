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
            console.error('[TelegramBotService] dispatch error:', err.message);
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
      await this.sendMessage(chatId, `❌ ${error.message}`);
    }
  }

  async showMainMenu(userId, chatId) {
    const user = this.userStore.getUser(userId);
    const hasSession = Boolean(user && !user.revoked && this.userSessionStore?.load(userId));
    const status = this.monitorCoordinator?.getStatus(userId);
    const menu = BotMenu.main({
      isRegistered: Boolean(user),
      isRevoked: Boolean(user?.revoked),
      isAdmin: this._isAdmin(userId),
      hasSession,
      monitorPhase: status?.phase ?? status?.status ?? null,
    });
    const text = !hasSession && user && !user.revoked
      ? `${menu.text}\nלחץ על 🔐 התחבר כדי לחבר את החשבון שלך.`
      : menu.text;
    await this.sendMessage(chatId, text, { reply_markup: menu.reply_markup });
  }

  async _runAction(action, { userId, chatId, fromUser }) {
    if (!this._isUser(userId)) {
      await this.showMainMenu(userId, chatId);
      return;
    }
    if (ADMIN_ACTIONS.has(action) && !this._isAdmin(userId)) {
      await this.showMainMenu(userId, chatId);
      return;
    }

    switch (action) {
      case 'login':
        await this._cmdLogin(userId, chatId, fromUser);
        return;
      case 'games':
      case 'change':
        await this._cmdGames(userId, chatId, fromUser);
        return;
      case 'status':
        await this._cmdStatus(userId, chatId, fromUser);
        return;
      case 'stop': {
        const status = this.monitorCoordinator?.getStatus(userId);
        const phase = status?.phase ?? status?.status;
        if (phase !== 'queued' && phase !== 'monitoring') {
          await this.showMainMenu(userId, chatId);
          return;
        }
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
      await this.sendMessage(chatId, `שגיאה בחיפוש משחקים: ${err.message}`);
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
    await this.sendMessage(chatId, `קישור הזמנה חדש: ${deepLink}\n(תקף ל־24 שעות ולשימוש אחד)`, {
      parse_mode: 'Markdown',
    });
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
    await this.monitorCoordinator?.stopMonitor(targetId);
    this.userStore.revokeUser(targetId);
    this.userStore.setMonitoringActive(targetId, false);
    this.userSessionStore?.delete(targetId);
    this._clearState(targetId);
    for (const [nonce, entry] of this._callbackHandlers) {
      if (entry.userId === String(targetId)) this.deregisterCallbackHandler(nonce);
    }
    await this.sendMessage(chatId, `✅ גישה בוטלה למשתמש ${targetId}.`);
  }

  async _startConfiguredMonitor(userId, chatId, data) {
    const { gameUrl, sections, quantity } = data;
    this.userStore.setMonitoringConfig(userId, { gameUrl, sections, quantity });
    await this.sendMessage(chatId, `⏳ מתחיל ניטור: גושים ${sections.join(', ')}, ${quantity} כרטיסים...`);
    try {
      const result = await this.monitorCoordinator.startMonitor(userId, {
        gameUrl,
        sections,
        quantity,
        chatId,
      });
      this.userStore.setMonitoringActive(userId, true);
      await this.sendMessage(chatId, result?.status === 'queued'
        ? '🕒 המעקב נשמר ונמצא בתור. הוא יתחיל אוטומטית כשיתפנה דפדפן.'
        : '✅ ניטור פעיל. תקבל התראה כשייפתחו כרטיסים.');
    } catch (err) {
      await this.sendMessage(chatId, `❌ שגיאה בהפעלת ניטור: ${err.message}`);
    }
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

    // Game selection
    const gameMatch = data.match(/^game:(\d+)$/);
    if (gameMatch) {
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
      const discovered = await this.monitorCoordinator.discoverSections(userId, game.url);
      const availableSections = [...new Set(discovered.map(section => String(section.label)))];
      if (!availableSections.length) {
        await this.sendMessage(chatId, `🎮 ${game.name}\nלא נמצאו גושים במפת המשחק כרגע.`);
        return;
      }
      const stateData = { gameUrl: game.url, availableSections, sections: [] };
      stateData.gameName = game.name;
      this._setState(userId, STATE.AWAITING_SECTIONS, stateData);
      await this.sendMessage(chatId, `🎮 ${game.name}\nבחר גושים ולחץ ✅ סיימתי:`, {
        reply_markup: { inline_keyboard: this._buildSectionsKeyboard(stateData) },
      });
      return;
    }

    const sectionMatch = data.match(/^section:(\d+)$/);
    if (sectionMatch) {
      const current = this._getState(userId);
      if (current.state !== STATE.AWAITING_SECTIONS) {
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
      await this.sendMessage(chatId, `נבחרו ${selected.size} גושים:`, {
        reply_markup: { inline_keyboard: this._buildSectionsKeyboard(current.data) },
      });
      return;
    }

    if (data === 'sections_done') {
      const current = this._getState(userId);
      if (current.state !== STATE.AWAITING_SECTIONS) {
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
      const current = this._getState(userId);
      if (current.state !== STATE.AWAITING_QUANTITY) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      const confirmation = { ...current.data, quantity: Number(quantityMatch[1]) };
      this._setState(userId, STATE.AWAITING_CONFIRMATION, confirmation);
      await this.sendMessage(chatId,
        `סיכום הניטור:\n🎮 משחק: ${confirmation.gameName || 'המשחק שנבחר'}\n` +
        `🪑 גושים: ${confirmation.sections.join(', ')}\n🎟 כמות: ${confirmation.quantity}\n\nלאשר התחלת ניטור?`,
        {
          reply_markup: { inline_keyboard: [
            [{ text: '✅ אשר ניטור', callback_data: 'setup:confirm' }],
            [
              { text: '⬅️ חזור לכמות', callback_data: 'setup:back' },
              { text: '✖️ ביטול', callback_data: 'setup:cancel' },
            ],
          ] },
        }
      );
      return;
    }

    if (data === 'setup:confirm') {
      const current = this._getState(userId);
      if (current.state !== STATE.AWAITING_CONFIRMATION) {
        await this.showMainMenu(userId, chatId);
        return;
      }
      // Claim this setup before awaiting the coordinator so repeat callbacks are stale.
      this._clearState(userId);
      await this._startConfiguredMonitor(userId, chatId, current.data);
      return;
    }

    if (data === 'setup:back') {
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
      await this._cmdGames(userId, chatId);
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

  _buildSectionsKeyboard({ availableSections = [], sections = [] }) {
    const selected = new Set(sections);
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
