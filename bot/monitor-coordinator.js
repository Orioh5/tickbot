'use strict';

const crypto = require('crypto');
const Monitor = require('../monitor');

class MonitorCoordinator {
  constructor({
    userStore,
    userSessionStore,
    gameDiscovery,
    telegramBotService,
    maxConcurrent = 3,
    MonitorClass = Monitor,
  }) {
    this.userStore = userStore;
    this.userSessionStore = userSessionStore;
    this.gameDiscovery = gameDiscovery;
    this.telegramBotService = telegramBotService;
    this.maxConcurrent = maxConcurrent;
    this.MonitorClass = MonitorClass;

    // userId → Monitor instance
    this._monitors = new Map();
    this._queue = [];
  }

  activeCount() {
    return this._monitors.size;
  }

  getStatus(userId) {
    const uid = String(userId);
    const running = this._monitors.get(uid)?.getStatus();
    if (running) return running;
    return this._queue.some(job => job.userId === uid)
      ? { running: false, busy: true, phase: 'queued' }
      : null;
  }

  async discoverGames(userId) {
    return this.gameDiscovery.discoverGames(userId);
  }

  async discoverSections(userId, gameUrl) {
    return this.gameDiscovery.discoverSections(userId, gameUrl);
  }

  async restoreActiveMonitors() {
    const rows = this.userStore.listActiveMonitoring?.() || [];
    for (const row of rows) {
      const uid = String(row.telegram_user_id);
      const user = this.userStore.getUser?.(uid);
      if (!user || user.revoked) {
        this.userStore.setMonitoringActive?.(uid, false);
        continue;
      }
      try {
        await this.startMonitor(uid, {
          gameUrl: row.game_url,
          sections: row.sections,
          quantity: row.quantity,
          chatId: uid,
        });
      } catch (error) {
        this.userStore.setMonitoringActive?.(uid, false);
      }
    }
  }

  async startMonitor(userId, { gameUrl, sections, quantity = 1, chatId }) {
    const uid = String(userId);
    if (this._monitors.has(uid)) {
      throw Object.assign(new Error('Monitor already running for this user'), { code: 'MONITOR_BUSY' });
    }
    if (this._queue.some(job => job.userId === uid)) {
      throw Object.assign(new Error('Monitor already queued for this user'), { code: 'MONITOR_BUSY' });
    }

    const storageState = this.userSessionStore.load(uid);
    if (!storageState) throw new Error('No saved session. Use /login first.');

    const args = { gameUrl, sections, quantity, chatId };
    if (this._monitors.size >= this.maxConcurrent) {
      this._queue.push({ userId: uid, args });
      return { status: 'queued' };
    }

    await this._startNow(uid, args, storageState);
    return { status: 'started' };
  }

  async _startNow(uid, { gameUrl, sections, quantity = 1, chatId }, suppliedStorageState = null) {
    const storageState = suppliedStorageState || this.userSessionStore.load(uid);
    if (!storageState) throw new Error('No saved session. Use /login first.');

    const monitor = new this.MonitorClass({
      ownerSelectorFactory: (settings) => this._makeOwnerSelector(uid, chatId, settings),
    });

    monitor.on('alert', message => {
      this.telegramBotService?.sendMessage(chatId, message).catch(() => {});
    });
    monitor.on('log', (message, level) => {
      if (level === 'error') {
        this.telegramBotService?.sendMessage(chatId, `⚠️ ${message}`).catch(() => {});
      }
    });

    this._monitors.set(uid, monitor);

    const settings = {
      url: gameUrl,
      sections,
      desiredQuantity: quantity,
      intervalMs: 10_000,
      pauseOnHit: true,
      headful: false,
      storageState,
      telegramToken: '',    // notifications go through telegramBotService directly
      telegramChatId: chatId,
      loginUrl: 'https://auth.mhaifafc.com/',
      loginUsername: '',
      loginPassword: '',
    };

    try {
      await monitor.start(settings);
    } catch (err) {
      this._monitors.delete(uid);
      throw err;
    }

    monitor.once('status', status => {
      if (!status.running) {
        this._monitors.delete(uid);
        this.userStore.setMonitoringActive?.(uid, false);
        void this._drainQueue();
      }
    });
  }

  async stopMonitor(userId) {
    const uid = String(userId);
    const queuedIndex = this._queue.findIndex(job => job.userId === uid);
    if (queuedIndex !== -1) {
      this._queue.splice(queuedIndex, 1);
      return;
    }
    const monitor = this._monitors.get(uid);
    if (!monitor) return;
    this._monitors.delete(uid);
    await monitor.stop();
    await this._drainQueue();
  }

  async _drainQueue() {
    while (this._monitors.size < this.maxConcurrent && this._queue.length) {
      const job = this._queue.shift();
      try {
        await this._startNow(job.userId, job.args);
      } catch (error) {
        this.userStore.setMonitoringActive?.(job.userId, false);
        await this.telegramBotService?.sendMessage(
          job.args.chatId,
          `❌ לא ניתן היה להתחיל את המעקב שבתור: ${error.message}`
        ).catch(() => {});
      }
    }
  }

  // ── Owner selector wired through TelegramBotService ────────────────────────

  _makeOwnerSelector(userId, chatId, _settings) {
    const bot = this.telegramBotService;
    return {
      async chooseOwner({ ticketNumber, candidates, signal }) {
        const nonce = crypto.randomBytes(8).toString('hex');
        return new Promise((resolve) => {
          let resolved = false;
          const finish = (candidateKey) => {
            if (resolved) return;
            resolved = true;
            resolve(candidateKey == null
              ? { status: 'timeout' }
              : { status: 'selected', candidateKey }
            );
          };

          bot.registerCallbackHandler(nonce, userId, finish, 180_000);

          signal?.addEventListener('abort', () => {
            bot.deregisterCallbackHandler(nonce);
            if (!resolved) {
              resolved = true;
              resolve({ status: 'cancelled' });
            }
          }, { once: true });

          const keyboard = candidates.map(c => [{ text: c.name, callback_data: `${nonce}:${c.key}` }]);
          bot.sendMessage(chatId, `בחר בעלים לכרטיס ${ticketNumber}:`, {
            reply_markup: { inline_keyboard: keyboard },
          }).catch(error => {
            bot.deregisterCallbackHandler(nonce);
            if (!resolved) {
              resolved = true;
              resolve({ status: 'error', message: error.message });
            }
          });
        });
      },
    };
  }
}

module.exports = MonitorCoordinator;
