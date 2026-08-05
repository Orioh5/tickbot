'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const GameDiscoveryService = require('../bot/game-discovery');

// Minimal stub for UserSessionStore
function makeSessionStore(state = { cookies: [], origins: [] }) {
  return { load: () => state };
}

// Minimal Playwright-compatible browser stub
function makeBrowser(pages = []) {
  let pageIndex = 0;
  return async (_storageState) => ({
    newContext: async () => ({
      newPage: async () => pages[pageIndex++] || makeEmptyPage(),
      close: async () => {},
    }),
    close: async () => {},
  });
}

function makeEmptyPage() {
  return {
    goto: async () => {},
    url: () => 'https://tickets.mhaifafc.com/',
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    evaluate: async () => [],
  };
}

function makeGamePage(games, { url = 'https://tickets.mhaifafc.com/', loginFormVisible = false } = {}) {
  return {
    goto: async () => {},
    url: () => url,
    locator: () => ({ first: () => ({ isVisible: async () => loginFormVisible }) }),
    evaluate: async () => games,
  };
}

function makeSectionPage(sections, { url = 'https://tickets.mhaifafc.com/event/123', loginFormVisible = false } = {}) {
  return {
    goto: async () => {},
    url: () => url,
    locator: () => ({ first: () => ({ isVisible: async () => loginFormVisible }) }),
    evaluate: async () => sections,
  };
}

// ── discoverGames ─────────────────────────────────────────────────────────────

test('discoverGames returns empty list when no games on page', async () => {
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeGamePage([])]),
  });
  const games = await svc.discoverGames('42');
  assert.deepEqual(games, []);
});

test('discoverGames returns scraped game list', async () => {
  const expected = [
    { name: 'מכבי חיפה - הפועל ת"א', url: 'https://tickets.mhaifafc.com/event/123' },
    { name: 'מכבי חיפה - בית"ר ירושלים', url: 'https://tickets.mhaifafc.com/event/456' },
  ];
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeGamePage(expected)]),
  });
  const games = await svc.discoverGames('42');
  assert.deepEqual(games, expected);
});

test('discoverGames throws when no session saved', async () => {
  const svc = new GameDiscoveryService({
    userSessionStore: { load: () => null },
    browserFactory: makeBrowser(),
  });
  await assert.rejects(() => svc.discoverGames('42'), /No saved session/);
});

test('redirect to the Maccabi login page is reported as SESSION_EXPIRED', async () => {
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeGamePage([], { url: 'https://auth.mhaifafc.com/login' })]),
  });

  await assert.rejects(
    () => svc.discoverGames('42'),
    error => error.code === 'SESSION_EXPIRED' && error.message === 'Saved session expired'
  );
});

test('a navigation failure is not misclassified as SESSION_EXPIRED', async () => {
  const navigationError = new Error('ticket site unavailable');
  const page = makeGamePage([]);
  page.goto = async () => { throw navigationError; };
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([page]),
  });

  await assert.rejects(
    () => svc.discoverGames('42'),
    error => error === navigationError && error.code === undefined
  );
});

// ── discoverSections ──────────────────────────────────────────────────────────

test('discoverSections returns sections from game page', async () => {
  const expected = [
    { id: '1590', label: '13' },
    { id: '1591', label: '14' },
  ];
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeSectionPage(expected)]),
  });
  const sections = await svc.discoverSections('42', 'https://tickets.mhaifafc.com/event/123');
  assert.deepEqual(sections, expected);
});

test('discoverSections throws when no session saved', async () => {
  const svc = new GameDiscoveryService({
    userSessionStore: { load: () => null },
    browserFactory: makeBrowser(),
  });
  await assert.rejects(() => svc.discoverSections('42', 'https://example.com'), /No saved session/);
});

test('a visible login form after game navigation is reported as SESSION_EXPIRED', async () => {
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeSectionPage([], { loginFormVisible: true })]),
  });

  await assert.rejects(
    () => svc.discoverSections('42', 'https://tickets.mhaifafc.com/event/123'),
    error => error.code === 'SESSION_EXPIRED'
  );
});

test('browser is always closed even on page error', async () => {
  let closed = false;
  const browser = {
    newContext: async () => { throw new Error('context failed'); },
    close: async () => { closed = true; },
  };
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: async () => browser,
  });
  await assert.rejects(() => svc.discoverGames('1'));
  assert.equal(closed, true);
});
