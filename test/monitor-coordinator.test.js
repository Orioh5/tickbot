'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const MonitorCoordinator = require('../bot/monitor-coordinator');

// ── Stubs ─────────────────────────────────────────────────────────────────────

function makeUserStore(users = {}) {
  return { getUser: id => users[id] ?? null };
}

function makeSessionStore(state = { cookies: [], origins: [] }) {
  return { load: () => state };
}

function makeGameDiscovery(games = []) {
  return { discoverGames: async () => games };
}

function makeBot() {
  const sent = [];
  return {
    sent,
    sendMessage: async (chatId, text, extra) => { sent.push({ chatId, text, extra }); },
    registerCallbackHandler: () => {},
    deregisterCallbackHandler: () => {},
  };
}

// Minimal Monitor stub
class StubMonitor extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this._phase = 'stopped';
  }
  getStatus() { return { running: this.running, busy: false, phase: this._phase }; }
  async start(settings) {
    this.running = true;
    this._phase = 'monitoring';
    this.emit('status', this.getStatus());
  }
  async stop() {
    this.running = false;
    this._phase = 'stopped';
    this.emit('status', this.getStatus());
  }
}

class DelayedStopMonitor extends EventEmitter {
  static instances = [];
  static activeBrowsers = 0;
  static maxActiveBrowsers = 0;

  constructor() {
    super();
    this.running = false;
    this.busy = false;
    this.phase = 'stopped';
    this.stopCalls = 0;
    this._stopGate = new Promise(resolve => { this._releaseStop = resolve; });
    DelayedStopMonitor.instances.push(this);
  }

  getStatus() {
    return { running: this.running, busy: this.busy, phase: this.phase };
  }

  async start() {
    this.running = true;
    this.busy = true;
    this.phase = 'monitoring';
    DelayedStopMonitor.activeBrowsers += 1;
    DelayedStopMonitor.maxActiveBrowsers = Math.max(
      DelayedStopMonitor.maxActiveBrowsers,
      DelayedStopMonitor.activeBrowsers
    );
  }

  async stop() {
    this.stopCalls += 1;
    this.running = false;
    this.phase = 'stopping';
    this.emit('status', this.getStatus());
    await this._stopGate;
    this.busy = false;
    this.phase = 'stopped';
    DelayedStopMonitor.activeBrowsers -= 1;
    this.emit('status', this.getStatus());
  }

  releaseStop() {
    this._releaseStop();
  }

  static reset() {
    this.instances = [];
    this.activeBrowsers = 0;
    this.maxActiveBrowsers = 0;
  }
}

function makeCoord({ maxConcurrent = 3, sessionState, gameList } = {}) {
  return new MonitorCoordinator({
    userStore: makeUserStore(),
    userSessionStore: makeSessionStore(sessionState),
    gameDiscovery: makeGameDiscovery(gameList),
    telegramBotService: makeBot(),
    maxConcurrent,
    MonitorClass: StubMonitor,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('activeCount starts at 0', () => {
  assert.equal(makeCoord().activeCount(), 0);
});

test('getStatus returns null for unknown user', () => {
  assert.equal(makeCoord().getStatus('42'), null);
});

test('startMonitor launches monitor and increments count', async () => {
  const coord = makeCoord();
  await coord.startMonitor('1', { gameUrl: 'https://example.com', sections: ['13'], quantity: 1, chatId: '1' });
  assert.equal(coord.activeCount(), 1);
  assert.equal(coord.getStatus('1').running, true);
});

test('startMonitor throws MONITOR_BUSY on second start for same user', async () => {
  const coord = makeCoord();
  await coord.startMonitor('1', { gameUrl: 'https://x.com', sections: ['1'], chatId: '1' });
  await assert.rejects(
    () => coord.startMonitor('1', { gameUrl: 'https://x.com', sections: ['1'], chatId: '1' }),
    /Monitor already running/
  );
});

test('startMonitor queues when concurrency cap is reached', async () => {
  const coord = makeCoord({ maxConcurrent: 2 });
  await coord.startMonitor('1', { gameUrl: 'https://x.com', sections: ['1'], chatId: '1' });
  await coord.startMonitor('2', { gameUrl: 'https://x.com', sections: ['1'], chatId: '2' });
  const result = await coord.startMonitor('3', { gameUrl: 'https://x.com', sections: ['1'], chatId: '3' });
  assert.equal(result.status, 'queued');
  assert.equal(coord.getStatus('3').phase, 'queued');
});

test('stopping a monitor promotes the next queued user', async () => {
  const coord = makeCoord({ maxConcurrent: 1 });
  await coord.startMonitor('1', { gameUrl: 'https://x.com', sections: ['1'], chatId: '1' });
  await coord.startMonitor('2', { gameUrl: 'https://x.com', sections: ['2'], chatId: '2' });
  await coord.stopMonitor('1');
  assert.equal(coord.getStatus('2').phase, 'monitoring');
});

test('startMonitor throws when no session saved', async () => {
  const coord = new MonitorCoordinator({
    userStore: makeUserStore(),
    userSessionStore: { load: () => null },
    gameDiscovery: makeGameDiscovery(),
    telegramBotService: makeBot(),
    MonitorClass: StubMonitor,
  });
  await assert.rejects(
    () => coord.startMonitor('1', { gameUrl: 'u', sections: [], chatId: '1' }),
    /No saved session/
  );
});

test('stopMonitor stops the monitor and decrements count', async () => {
  const coord = makeCoord();
  await coord.startMonitor('1', { gameUrl: 'https://x.com', sections: ['1'], chatId: '1' });
  await coord.stopMonitor('1');
  assert.equal(coord.activeCount(), 0);
  assert.equal(coord.getStatus('1'), null);
});

test('stopMonitor is a no-op when no monitor running', async () => {
  const coord = makeCoord();
  await assert.doesNotReject(() => coord.stopMonitor('unknown'));
});

test('alert event forwards message to bot', async () => {
  const bot = makeBot();
  const coord = new MonitorCoordinator({
    userStore: makeUserStore(),
    userSessionStore: makeSessionStore(),
    gameDiscovery: makeGameDiscovery(),
    telegramBotService: bot,
    MonitorClass: StubMonitor,
  });
  await coord.startMonitor('1', { gameUrl: 'u', sections: [], chatId: 'chat1' });
  const monitor = coord._monitors.get('1');
  monitor.emit('alert', 'כרטיסים זמינים!');
  // Give the microtask queue a tick
  await new Promise(r => setImmediate(r));
  assert.ok(bot.sent.some(m => m.chatId === 'chat1' && m.text === 'כרטיסים זמינים!'));
});

test('discoverGames delegates to gameDiscovery', async () => {
  const coord = makeCoord({ gameList: [{ name: 'Game A', url: 'https://x.com/1' }] });
  const games = await coord.discoverGames('1');
  assert.deepEqual(games, [{ name: 'Game A', url: 'https://x.com/1' }]);
});

test('session expiry stops and removes only the affected active user and offers reconnect', async () => {
  const activeChanges = [];
  const sessions = new Map([
    ['1', { cookies: [{ name: 'session-a' }], origins: [] }],
    ['2', { cookies: [{ name: 'session-b' }], origins: [] }],
  ]);
  const sessionStore = {
    load: userId => sessions.get(String(userId)) ?? null,
    delete: userId => sessions.delete(String(userId)),
  };
  const bot = makeBot();
  const coord = new MonitorCoordinator({
    userStore: { setMonitoringActive: (id, active) => activeChanges.push([String(id), active]) },
    userSessionStore: sessionStore,
    gameDiscovery: makeGameDiscovery(),
    telegramBotService: bot,
    MonitorClass: StubMonitor,
  });
  await coord.startMonitor('1', { gameUrl: 'u1', sections: ['13'], chatId: '1' });
  await coord.startMonitor('2', { gameUrl: 'u2', sections: ['14'], chatId: '2' });

  await coord.handleSessionExpired('1');

  assert.equal(coord.getStatus('1'), null);
  assert.equal(coord.getStatus('2').phase, 'monitoring');
  assert.equal(sessions.has('1'), false);
  assert.equal(sessions.has('2'), true);
  assert.ok(activeChanges.some(change => change[0] === '1' && change[1] === false));
  assert.ok(!activeChanges.some(change => change[0] === '2'));
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].chatId, '1');
  assert.match(bot.sent[0].text, /🔐 התחבר מחדש/);
  assert.deepEqual(
    bot.sent[0].extra.reply_markup.inline_keyboard.flat().map(button => button.callback_data),
    ['menu:login']
  );
});

test('session expiry removes only the affected queued work', async () => {
  const sessions = new Map([['1', {}], ['2', {}], ['3', {}]]);
  const coord = new MonitorCoordinator({
    userStore: { setMonitoringActive: () => {} },
    userSessionStore: {
      load: userId => sessions.get(String(userId)) ?? null,
      delete: userId => sessions.delete(String(userId)),
    },
    gameDiscovery: makeGameDiscovery(),
    telegramBotService: makeBot(),
    maxConcurrent: 1,
    MonitorClass: StubMonitor,
  });
  await coord.startMonitor('1', { gameUrl: 'u1', sections: ['13'], chatId: '1' });
  await coord.startMonitor('2', { gameUrl: 'u2', sections: ['14'], chatId: '2' });
  await coord.startMonitor('3', { gameUrl: 'u3', sections: ['15'], chatId: '3' });

  await coord.handleSessionExpired('2');
  await coord.stopMonitor('1');

  assert.equal(coord.getStatus('2'), null);
  assert.equal(coord.getStatus('3').phase, 'monitoring');
  assert.equal(sessions.has('2'), false);
  assert.equal(sessions.has('3'), true);
});

test('discovery expiry performs target cleanup and rethrows SESSION_EXPIRED', async () => {
  const expired = Object.assign(new Error('Saved session expired'), { code: 'SESSION_EXPIRED' });
  const deleted = [];
  const activeChanges = [];
  const bot = makeBot();
  const coord = new MonitorCoordinator({
    userStore: { setMonitoringActive: (id, active) => activeChanges.push([String(id), active]) },
    userSessionStore: {
      load: () => ({ cookies: [], origins: [] }),
      delete: id => deleted.push(String(id)),
    },
    gameDiscovery: { discoverGames: async () => { throw expired; } },
    telegramBotService: bot,
    MonitorClass: StubMonitor,
  });

  await assert.rejects(() => coord.discoverGames('7'), error => error === expired);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(deleted, ['7']);
  assert.deepEqual(activeChanges, [['7', false]]);
  assert.match(bot.sent[0].text, /🔐 התחבר מחדש/);
});

test('active monitor SESSION_EXPIRED event cleans only its owner and leaves another monitor active', async () => {
  const sessions = new Map([['1', {}], ['2', {}]]);
  const bot = makeBot();
  const coord = new MonitorCoordinator({
    userStore: { setMonitoringActive: () => {} },
    userSessionStore: {
      load: id => sessions.get(String(id)) ?? null,
      loadWithGeneration: id => sessions.has(String(id))
        ? { storageState: sessions.get(String(id)), generation: 1 }
        : null,
      deleteIfGeneration: id => sessions.delete(String(id)),
    },
    gameDiscovery: makeGameDiscovery(),
    telegramBotService: bot,
    MonitorClass: StubMonitor,
  });
  await coord.startMonitor('1', { gameUrl: 'u1', sections: ['13'], chatId: '1' });
  await coord.startMonitor('2', { gameUrl: 'u2', sections: ['14'], chatId: '2' });
  const expired = Object.assign(new Error('Saved session expired'), { code: 'SESSION_EXPIRED' });

  coord._monitors.get('1').emit('sessionExpired', expired);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(coord.getStatus('1'), null);
  assert.equal(coord.getStatus('2').phase, 'monitoring');
  assert.equal(sessions.has('1'), false);
  assert.equal(sessions.has('2'), true);
  assert.equal(bot.sent.filter(message => message.chatId === '1').length, 1);
});

test('stale expiry event from a settled monitor cannot stop a refreshed generation monitor', async () => {
  let generation = 1;
  let state = { cookies: [{ value: 'expired' }], origins: [] };
  const sessionStore = {
    load: () => state,
    loadWithGeneration: () => ({ storageState: state, generation }),
    deleteIfGeneration: (_id, expected) => {
      if (expected !== generation) return false;
      state = null;
      return true;
    },
  };
  const coord = new MonitorCoordinator({
    userStore: { setMonitoringActive: () => {} },
    userSessionStore: sessionStore,
    gameDiscovery: makeGameDiscovery(),
    telegramBotService: makeBot(),
    MonitorClass: StubMonitor,
  });
  await coord.startMonitor('1', { gameUrl: 'u1', sections: ['13'], chatId: '1' });
  const oldMonitor = coord._monitors.get('1');
  await coord.stopMonitor('1');
  generation = 2;
  state = { cookies: [{ value: 'fresh' }], origins: [] };
  await coord.startMonitor('1', { gameUrl: 'u2', sections: ['14'], chatId: '1' });
  const freshMonitor = coord._monitors.get('1');

  oldMonitor.emit('sessionExpired', Object.assign(new Error('expired'), { code: 'SESSION_EXPIRED' }));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(coord._monitors.get('1'), freshMonitor);
  assert.equal(coord.getStatus('1').phase, 'monitoring');
  assert.equal(state.cookies[0].value, 'fresh');
});

test('expiry teardown stays counted until delayed stop settles and duplicate expiry coalesces', async () => {
  DelayedStopMonitor.reset();
  const sessions = new Map([['1', {}], ['2', {}]]);
  const bot = makeBot();
  const coord = new MonitorCoordinator({
    userStore: { setMonitoringActive: () => {} },
    userSessionStore: {
      load: id => sessions.get(String(id)) ?? null,
      loadWithGeneration: id => sessions.has(String(id))
        ? { storageState: sessions.get(String(id)), generation: 1 }
        : null,
      deleteIfGeneration: id => sessions.delete(String(id)),
    },
    gameDiscovery: makeGameDiscovery(),
    telegramBotService: bot,
    maxConcurrent: 1,
    MonitorClass: DelayedStopMonitor,
  });
  await coord.startMonitor('1', { gameUrl: 'u1', sections: ['13'], chatId: '1' });
  const firstMonitor = DelayedStopMonitor.instances[0];

  const firstCleanup = coord.handleSessionExpired('1');
  const duplicateCleanup = coord.handleSessionExpired('1');
  await new Promise(resolve => setImmediate(resolve));
  const secondStart = await coord.startMonitor('2', { gameUrl: 'u2', sections: ['14'], chatId: '2' });

  assert.equal(secondStart.status, 'queued');
  assert.equal(coord.activeCount(), 1);
  assert.equal(coord.getStatus('1').phase, 'stopping');
  assert.equal(firstMonitor.stopCalls, 1);
  assert.equal(DelayedStopMonitor.maxActiveBrowsers, 1);

  firstMonitor.releaseStop();
  await Promise.all([firstCleanup, duplicateCleanup]);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(coord.getStatus('1'), null);
  assert.equal(coord.getStatus('2').phase, 'monitoring');
  assert.equal(DelayedStopMonitor.maxActiveBrowsers, 1);
  assert.equal(bot.sent.filter(message => message.chatId === '1').length, 1);
});

test('failed expiry stop keeps the busy monitor tracked and does not promote queued work', async () => {
  class FailingStopMonitor extends StubMonitor {
    getStatus() { return { running: this.running, busy: true, phase: this._phase }; }
    async stop() { throw new Error('browser close failed'); }
  }
  const coord = new MonitorCoordinator({
    userStore: { setMonitoringActive: () => {} },
    userSessionStore: {
      load: () => ({}),
      loadWithGeneration: () => ({ storageState: {}, generation: 1 }),
      deleteIfGeneration: () => true,
    },
    gameDiscovery: makeGameDiscovery(),
    telegramBotService: makeBot(),
    maxConcurrent: 1,
    MonitorClass: FailingStopMonitor,
  });
  await coord.startMonitor('1', { gameUrl: 'u1', sections: ['13'], chatId: '1' });
  await coord.startMonitor('2', { gameUrl: 'u2', sections: ['14'], chatId: '2' });

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await coord.handleSessionExpired('1');
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(coord.activeCount(), 1);
  assert.ok(coord.getStatus('1'));
  assert.equal(coord.getStatus('2').phase, 'queued');
});

test('fresh login saved during expiry teardown survives generation-conditional deletion', async () => {
  DelayedStopMonitor.reset();
  let generation = 1;
  let state = { cookies: [{ value: 'expired' }], origins: [] };
  const sessionStore = {
    load: () => state,
    loadWithGeneration: () => state ? { storageState: state, generation } : null,
    save: freshState => {
      generation += 1;
      state = freshState;
      return generation;
    },
    deleteIfGeneration: (_id, expectedGeneration) => {
      if (generation !== expectedGeneration) return false;
      state = null;
      return true;
    },
    delete: () => { state = null; },
  };
  const coord = new MonitorCoordinator({
    userStore: { setMonitoringActive: () => {} },
    userSessionStore: sessionStore,
    gameDiscovery: makeGameDiscovery(),
    telegramBotService: makeBot(),
    maxConcurrent: 1,
    MonitorClass: DelayedStopMonitor,
  });
  await coord.startMonitor('1', { gameUrl: 'u1', sections: ['13'], chatId: '1' });
  const monitor = DelayedStopMonitor.instances[0];

  const cleanup = coord.handleSessionExpired('1');
  await new Promise(resolve => setImmediate(resolve));
  const freshState = { cookies: [{ value: 'fresh' }], origins: [] };
  sessionStore.save(freshState);
  monitor.releaseStop();
  await cleanup;

  assert.deepEqual(state, freshState);
  assert.equal(generation, 2);
});

test('discovery rethrows original expiry without waiting for a hung queue drain', async () => {
  const expired = Object.assign(new Error('Saved session expired'), { code: 'SESSION_EXPIRED' });
  const coord = new MonitorCoordinator({
    userStore: { setMonitoringActive: () => {} },
    userSessionStore: {
      load: () => ({}),
      loadWithGeneration: () => ({ storageState: {}, generation: 1 }),
      deleteIfGeneration: () => true,
    },
    gameDiscovery: { discoverGames: async () => { throw expired; } },
    telegramBotService: makeBot(),
    MonitorClass: StubMonitor,
  });
  coord._drainQueue = () => new Promise(() => {});

  const result = await Promise.race([
    coord.discoverGames('1').then(
      () => ({ resolved: true }),
      error => ({ error })
    ),
    new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 50)),
  ]);

  assert.deepEqual(result, { error: expired });
});

test('stale discovery expiry after a fresh login neither deletes nor prompts the refreshed session', async () => {
  const expired = Object.assign(new Error('Saved session expired'), { code: 'SESSION_EXPIRED' });
  let rejectDiscovery;
  const discovery = new Promise((_resolve, reject) => { rejectDiscovery = reject; });
  let generation = 1;
  let state = { cookies: [{ value: 'expired' }], origins: [] };
  const bot = makeBot();
  const coord = new MonitorCoordinator({
    userStore: { setMonitoringActive: () => {} },
    userSessionStore: {
      load: () => state,
      loadWithGeneration: () => ({ storageState: state, generation }),
      deleteIfGeneration: (_id, expected) => {
        if (expected !== generation) return false;
        state = null;
        return true;
      },
    },
    gameDiscovery: { discoverGames: async () => discovery },
    telegramBotService: bot,
    MonitorClass: StubMonitor,
  });

  const request = coord.discoverGames('1');
  generation = 2;
  state = { cookies: [{ value: 'fresh' }], origins: [] };
  rejectDiscovery(expired);
  await assert.rejects(() => request, error => error === expired);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(state.cookies[0].value, 'fresh');
  assert.equal(bot.sent.length, 0);
});

test('owner selection fails immediately when Telegram cannot send the question', async () => {
  const bot = {
    registerCallbackHandler: () => {},
    deregisterCallbackHandler: () => {},
    sendMessage: async () => { throw new Error('Telegram unavailable'); },
  };
  const coord = new MonitorCoordinator({
    userStore: makeUserStore(),
    userSessionStore: makeSessionStore(),
    gameDiscovery: makeGameDiscovery(),
    telegramBotService: bot,
    MonitorClass: StubMonitor,
  });
  const selector = coord._makeOwnerSelector('1', '1');
  const result = await selector.chooseOwner({
    ticketNumber: 1,
    candidates: [{ key: 'a', name: 'Owner' }],
    signal: new AbortController().signal,
  });
  assert.equal(result.status, 'error');
  assert.match(result.message, /Telegram unavailable/);
});

test('restoreActiveMonitors restarts persisted jobs and queues overflow', async () => {
  const userStore = {
    listActiveMonitoring: () => [
      { telegram_user_id: '1', game_url: 'u1', sections: ['13'], quantity: 1 },
      { telegram_user_id: '2', game_url: 'u2', sections: ['14'], quantity: 2 },
    ],
    getUser: id => ({ telegram_user_id: String(id), revoked: 0 }),
    setMonitoringActive: () => {},
  };
  const coord = new MonitorCoordinator({
    userStore,
    userSessionStore: makeSessionStore(),
    gameDiscovery: makeGameDiscovery(),
    telegramBotService: makeBot(),
    maxConcurrent: 1,
    MonitorClass: StubMonitor,
  });
  await coord.restoreActiveMonitors();
  assert.equal(coord.getStatus('1').phase, 'monitoring');
  assert.equal(coord.getStatus('2').phase, 'queued');
});

test('a monitor that stops itself clears its persisted active flag', async () => {
  const activeChanges = [];
  const coord = new MonitorCoordinator({
    userStore: { setMonitoringActive: (id, active) => activeChanges.push([String(id), active]) },
    userSessionStore: makeSessionStore(),
    gameDiscovery: makeGameDiscovery(),
    telegramBotService: makeBot(),
    MonitorClass: StubMonitor,
  });
  await coord.startMonitor('1', { gameUrl: 'u', sections: ['13'], chatId: '1' });
  const monitor = coord._monitors.get('1');
  monitor.running = false;
  monitor._phase = 'stopped';
  monitor.emit('status', monitor.getStatus());
  assert.deepEqual(activeChanges, [['1', false]]);
});
