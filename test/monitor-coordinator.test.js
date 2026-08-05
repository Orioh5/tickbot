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
