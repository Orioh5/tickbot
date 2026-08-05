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
    this._monitorSessionGenerations = new Map();
    this._queue = [];
    // userId → Map<session generation or monitor identity, cleanup Promise>
    this._expiryCleanups = new Map();
    this._notifiedExpiryGenerations = new Map();
    this._notifiedExpiryMonitors = new WeakSet();
    this._tearingDown = new Set();
    this._drainPromise = null;
    this._monitorLifecycleHandlers = new WeakMap();
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
    return this._runDiscovery(userId, () => this.gameDiscovery.discoverGames(userId));
  }

  async discoverSections(userId, gameUrl) {
    return this._runDiscovery(userId, () => this.gameDiscovery.discoverSections(userId, gameUrl));
  }

  async _runDiscovery(userId, operation) {
    const uid = String(userId);
    const expiredGeneration = this._loadSessionRecord(uid)?.generation ?? null;
    try {
      return await operation();
    } catch (error) {
      if (error?.code === 'SESSION_EXPIRED') {
        void this.handleSessionExpired(uid, expiredGeneration).catch(() => {
          console.error('[MonitorCoordinator] Session expiry cleanup failed.');
        });
      }
      throw error;
    }
  }

  _loadSessionRecord(userId) {
    if (typeof this.userSessionStore.loadWithGeneration === 'function') {
      return this.userSessionStore.loadWithGeneration(userId);
    }
    const storageState = this.userSessionStore.load(userId);
    return storageState ? { storageState, generation: null } : null;
  }

  handleSessionExpired(userId, expiredGeneration = undefined) {
    const uid = String(userId);
    const expiredMonitor = this._monitors.get(uid) ?? null;
    const generation = expiredGeneration === undefined
      ? (this._monitorSessionGenerations.get(uid) ?? this._loadSessionRecord(uid)?.generation ?? null)
      : expiredGeneration;
    const identity = generation ?? expiredMonitor ?? 'no-session-generation';
    let userCleanups = this._expiryCleanups.get(uid);
    const existing = userCleanups?.get(identity);
    if (existing) return existing;
    if (!userCleanups) {
      userCleanups = new Map();
      this._expiryCleanups.set(uid, userCleanups);
    }
    const cleanup = Promise.resolve().then(() =>
      this._performSessionExpiryCleanup(uid, generation, expiredMonitor));
    userCleanups.set(identity, cleanup);
    void cleanup.finally(() => {
      const current = this._expiryCleanups.get(uid);
      if (current?.get(identity) === cleanup) current.delete(identity);
      if (current?.size === 0) this._expiryCleanups.delete(uid);
    }).catch(() => {});
    return cleanup;
  }

  async _performSessionExpiryCleanup(uid, expiredGeneration, expiredMonitor) {
    const currentMonitor = this._monitors.get(uid) ?? null;
    if (expiredMonitor && currentMonitor !== expiredMonitor) return;
    const monitor = expiredMonitor || currentMonitor;
    const monitorGeneration = this._monitorSessionGenerations.get(uid);
    if (monitor && expiredGeneration != null && monitorGeneration != null &&
        monitorGeneration !== expiredGeneration) {
      return;
    }
    const currentSessionGeneration = this._loadSessionRecord(uid)?.generation ?? null;
    if (!monitor && expiredGeneration != null && currentSessionGeneration != null &&
        currentSessionGeneration !== expiredGeneration) {
      return;
    }
    if (this._markReconnectNotification(uid, expiredGeneration, monitor)) {
      void this._sendReconnect(uid);
    }

    // Remove the target's queued work before stopping an active monitor, because
    // stop/completion events may immediately drain the remaining shared queue.
    this._queue = this._queue.filter(job => job.userId !== uid);
    let settled = !monitor;
    if (monitor) {
      this._tearingDown.add(uid);
      try {
        await monitor.stop();
        await this._waitForMonitorSettlement(monitor);
        settled = true;
      } catch (_) {
        settled = this._isMonitorSettled(monitor);
        console.error('[MonitorCoordinator] Monitor stop failed during session expiry cleanup.');
      } finally {
        this._tearingDown.delete(uid);
      }
    }

    try { this.userStore.setMonitoringActive?.(uid, false); } catch (_) {}
    try {
      if (expiredGeneration != null && typeof this.userSessionStore.deleteIfGeneration === 'function') {
        await this.userSessionStore.deleteIfGeneration(uid, expiredGeneration);
      } else {
        await this.userSessionStore.delete(uid);
      }
    } catch (_) {}

    if (settled && this._monitors.get(uid) === monitor) {
      this._monitors.delete(uid);
      this._monitorSessionGenerations.delete(uid);
      this._detachMonitorLifecycle(monitor);
    }
    if (settled) this._scheduleDrainQueue();
  }

  _markReconnectNotification(uid, generation, monitor) {
    if (generation != null) {
      let generations = this._notifiedExpiryGenerations.get(uid);
      if (!generations) {
        generations = new Set();
        this._notifiedExpiryGenerations.set(uid, generations);
      }
      if (generations.has(generation)) return false;
      generations.add(generation);
      if (generations.size > 32) generations.delete(generations.values().next().value);
      return true;
    }
    if (monitor) {
      if (this._notifiedExpiryMonitors.has(monitor)) return false;
      this._notifiedExpiryMonitors.add(monitor);
    }
    return true;
  }

  async _sendReconnect(uid) {
    try {
      await this.telegramBotService?.sendMessage(uid, '🔐 התחבר מחדש כדי להמשיך לבחור משחקים ולנטר כרטיסים.', {
        reply_markup: { inline_keyboard: [[
          { text: '🔐 התחבר מחדש', callback_data: 'menu:login' },
        ]] },
      });
    } catch (_) {
      console.error('[MonitorCoordinator] Telegram reconnect notification failed.');
    }
  }

  _isMonitorSettled(monitor) {
    const status = monitor?.getStatus?.();
    return !status?.running && !status?.busy;
  }

  _detachMonitorLifecycle(monitor) {
    const handlers = this._monitorLifecycleHandlers.get(monitor);
    if (!handlers) return;
    monitor.removeListener('status', handlers.onStatus);
    monitor.removeListener('sessionExpired', handlers.onSessionExpired);
    this._monitorLifecycleHandlers.delete(monitor);
  }

  async _waitForMonitorSettlement(monitor) {
    if (this._isMonitorSettled(monitor)) return;
    await new Promise(resolve => {
      const onStatus = () => {
        if (!this._isMonitorSettled(monitor)) return;
        monitor.removeListener('status', onStatus);
        resolve();
      };
      monitor.on('status', onStatus);
      onStatus();
    });
  }

  _scheduleDrainQueue() {
    if (this._drainPromise) return this._drainPromise;
    const drain = Promise.resolve().then(async () => {
      try {
        await this._drainQueue();
      } catch (_) {
        console.error('[MonitorCoordinator] Queued monitor promotion failed.');
      } finally {
        if (this._drainPromise === drain) this._drainPromise = null;
      }
      if (this._queue.length && this._monitors.size < this.maxConcurrent) {
        await this._scheduleDrainQueue();
      }
    });
    this._drainPromise = drain;
    return drain;
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

    const session = this._loadSessionRecord(uid);
    if (!session) throw new Error('No saved session. Use /login first.');

    const args = { gameUrl, sections, quantity, chatId };
    if (this._monitors.size >= this.maxConcurrent) {
      this._queue.push({ userId: uid, args });
      return { status: 'queued' };
    }

    await this._startNow(uid, args, session);
    return { status: 'started' };
  }

  async _startNow(uid, { gameUrl, sections, quantity = 1, chatId }, suppliedSession = null) {
    const session = suppliedSession || this._loadSessionRecord(uid);
    if (!session) throw new Error('No saved session. Use /login first.');
    const { storageState, generation } = session;

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
    const onSessionExpired = error => {
      if (error?.code !== 'SESSION_EXPIRED') return;
      void this.handleSessionExpired(uid, generation).catch(() => {
        console.error('[MonitorCoordinator] Active monitor expiry cleanup failed.');
      });
    };
    monitor.once('sessionExpired', onSessionExpired);

    const onStatus = status => {
      if (status.running || status.busy) return;
      if (this._monitors.get(uid) !== monitor) {
        this._detachMonitorLifecycle(monitor);
        return;
      }
      if (this._tearingDown.has(uid)) return;
      this._monitors.delete(uid);
      this._monitorSessionGenerations.delete(uid);
      this._detachMonitorLifecycle(monitor);
      try { this.userStore.setMonitoringActive?.(uid, false); } catch (_) {}
      this._scheduleDrainQueue();
    };
    monitor.on('status', onStatus);
    this._monitorLifecycleHandlers.set(monitor, { onStatus, onSessionExpired });

    this._monitors.set(uid, monitor);
    this._monitorSessionGenerations.set(uid, generation);

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
      loginUrl: 'https://auth.mhaifafc.com/login',
      loginUsername: '',
      loginPassword: '',
    };

    try {
      await monitor.start(settings);
    } catch (err) {
      if (this._monitors.get(uid) === monitor) this._monitors.delete(uid);
      this._monitorSessionGenerations.delete(uid);
      this._detachMonitorLifecycle(monitor);
      throw err;
    }
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
    this._tearingDown.add(uid);
    let settled = false;
    try {
      await monitor.stop();
      await this._waitForMonitorSettlement(monitor);
      settled = true;
    } finally {
      this._tearingDown.delete(uid);
      if (settled && this._monitors.get(uid) === monitor) {
        this._monitors.delete(uid);
        this._monitorSessionGenerations.delete(uid);
        this._detachMonitorLifecycle(monitor);
      }
    }
    if (settled) await this._scheduleDrainQueue();
  }

  async _drainQueue() {
    while (this._monitors.size < this.maxConcurrent && this._queue.length) {
      const job = this._queue.shift();
      try {
        await this._startNow(job.userId, job.args);
      } catch (error) {
        this.userStore.setMonitoringActive?.(job.userId, false);
        try {
          await this.telegramBotService?.sendMessage(
            job.args.chatId,
            '❌ לא ניתן היה להתחיל את המעקב שבתור. התחבר מחדש ונסה שוב.'
          );
        } catch (_) {}
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
