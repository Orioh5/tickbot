'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const GameDiscoveryService = require('../bot/game-discovery');
const { extractGamesFromDocument, formatOpponentName } = require('../bot/game-discovery');

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

function makeGamePage(games, {
  url = 'https://tickets.mhaifafc.com/',
  loginFormVisible = false,
  stadiumTitles = {},
  gamesAfterWait = null,
} = {}) {
  let currentUrl = url;
  let visibleGames = games;
  return {
    goto: async target => {
      if (!url.startsWith('https://auth.mhaifafc.com/')) currentUrl = target;
    },
    url: () => currentUrl,
    locator: selector => ({
      first: () => ({
        isVisible: async () => selector.includes('input[type="password"]') && loginFormVisible,
        textContent: async () => stadiumTitles[currentUrl] ?? null,
        waitFor: async () => { if (gamesAfterWait) visibleGames = gamesAfterWait; },
      }),
    }),
    evaluate: async () => visibleGames,
  };
}

function makeSectionPage(sections, {
  url = 'https://tickets.mhaifafc.com/event/123',
  loginFormVisible = false,
  sectionsAfterWait = null,
} = {}) {
  let visibleSections = sections;
  return {
    goto: async () => {},
    url: () => url,
    locator: selector => ({ first: () => ({
      isVisible: async () => loginFormVisible,
      waitFor: async () => {
        if (selector.includes('processSectorById') && sectionsAfterWait) {
          visibleSections = sectionsAfterWait;
        }
      },
    }) }),
    evaluate: async () => visibleSections,
  };
}

// ── discoverGames ─────────────────────────────────────────────────────────────

test('formatOpponentName returns only the opponent for recognized fixtures', () => {
  const cases = [
    ['מכבי חיפה - בני סכנין', 'בני סכנין'],
    ['בני סכנין – מכבי חיפה', 'בני סכנין'],
    ['מכבי חיפה — בני סכנין 08/08/2026 20:30', 'בני סכנין'],
    ['מכבי חיפה נגד בני סכנין', 'בני סכנין'],
    ['חניה מכבי חיפה - הפועל ירושלים 17.08.26', 'הפועל ירושלים'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(formatOpponentName(input), expected);
  }
});

test('formatOpponentName keeps ambiguous listing titles', () => {
  assert.equal(formatOpponentName('משחק 6154'), 'משחק 6154');
  assert.equal(formatOpponentName('גמר גביע המדינה'), 'גמר גביע המדינה');
});

test('discoverGames returns empty list when no games on page', async () => {
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeGamePage([])]),
  });
  const games = await svc.discoverGames('42');
  assert.deepEqual(games, []);
});

test('discoverGames returns scraped game list', async () => {
  const listed = [
    { name: 'מכבי חיפה - הפועל ת"א', url: 'https://tickets.mhaifafc.com/event/123' },
    { name: 'מכבי חיפה - בית"ר ירושלים', url: 'https://tickets.mhaifafc.com/event/456' },
  ];
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeGamePage(listed)]),
  });
  const games = await svc.discoverGames('42');
  assert.deepEqual(games, [
    { name: 'הפועל ת"א', url: listed[0].url },
    { name: 'בית"ר ירושלים', url: listed[1].url },
  ]);
});

test('discoverGames waits for dynamically rendered event links', async () => {
  const expected = [{
    name: 'מכבי חיפה - הפועל ירושלים',
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=6220',
  }];
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeGamePage([], { gamesAfterWait: expected })]),
  });

  assert.deepEqual(await svc.discoverGames('42'), [{
    name: 'הפועל ירושלים',
    url: expected[0].url,
  }]);
});

test('discoverGames reuses a short per-user cache without sharing mutable results', async () => {
  const expected = [{ name: 'מכבי חיפה', url: 'https://tickets.mhaifafc.com/event/123' }];
  let browserLaunches = 0;
  const createBrowser = makeBrowser([makeGamePage(expected)]);
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: async storageState => {
      browserLaunches++;
      return createBrowser(storageState);
    },
  });

  const first = await svc.discoverGames('42');
  first[0].name = 'changed by caller';
  const second = await svc.discoverGames('42');

  assert.equal(browserLaunches, 1);
  assert.deepEqual(second, expected);
});

test('discoverGames uses only the listing page and returns opponent labels', async () => {
  const listed = [
    { name: 'מכבי חיפה - בני סכנין 08/08/2026 20:30', url: 'https://tickets.mhaifafc.com/event/1' },
    { name: 'הפועל באר שבע – מכבי חיפה', url: 'https://tickets.mhaifafc.com/event/2' },
  ];
  let pageCount = 0;
  const navigations = [];
  const listingPage = makeGamePage(listed);
  const originalGoto = listingPage.goto;
  listingPage.goto = async (url, options) => {
    navigations.push({ url, waitUntil: options.waitUntil });
    await originalGoto(url, options);
  };
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: async () => ({
      newContext: async () => ({
        newPage: async () => { pageCount++; return listingPage; },
        close: async () => {},
      }),
      close: async () => {},
    }),
  });

  const result = await svc.discoverGames('42');

  assert.equal(pageCount, 1);
  assert.deepEqual(navigations, [{
    url: 'https://tickets.mhaifafc.com/',
    waitUntil: 'domcontentloaded',
  }]);
  assert.deepEqual(result, [
    { name: 'בני סכנין', url: listed[0].url },
    { name: 'הפועל באר שבע', url: listed[1].url },
  ]);
});

test('extractGamesFromDocument recognizes current Stadium event links without a text name', () => {
  const anchor = {
    href: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=6154',
    textContent: 'add_shopping_cartלהזמנה',
    querySelector: () => null,
    closest: () => null,
  };
  const document = {
    querySelectorAll: selector => {
      assert.match(selector, /Stadium\/Index/);
      return [anchor];
    },
  };

  assert.deepEqual(extractGamesFromDocument(document), [{
    name: 'משחק 6154',
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=6154',
  }]);
});

test('extractGamesFromDocument reads the fixture name from the card accessibility label', () => {
  const card = {
    querySelector: () => ({
      getAttribute: name => name === 'aria-label'
        ? 'קנה כרטיס לאירוע מכבי חיפה - הפועל ירושלים'
        : null,
    }),
  };
  const anchor = {
    href: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=6220',
    textContent: 'add_shopping_cart להזמנה',
    querySelector: () => null,
    closest: () => card,
  };

  assert.deepEqual(extractGamesFromDocument({ querySelectorAll: () => [anchor] }), [{
    name: 'מכבי חיפה - הפועל ירושלים',
    url: anchor.href,
  }]);
});

test('extractGamesFromDocument uses the browser document when Playwright passes no argument', () => {
  const anchor = {
    href: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=6154',
    textContent: 'להזמנה',
    querySelector: () => null,
    closest: () => null,
  };
  const context = {
    document: { querySelectorAll: () => [anchor] },
    URL,
  };

  const games = vm.runInNewContext(`(${extractGamesFromDocument.toString()})()`, context);
  assert.equal(games[0].name, 'משחק 6154');
  assert.equal(games[0].url, anchor.href);
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

test('discoverSections waits for dynamically rendered section controls', async () => {
  const expected = [{ id: '1590', label: '13' }];
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeSectionPage([], { sectionsAfterWait: expected })]),
  });

  assert.deepEqual(
    await svc.discoverSections('42', 'https://tickets.mhaifafc.com/Stadium/Index?eventId=6220'),
    expected
  );
});

test('discoverEventMap preserves a combined clickable area and a sold-out map area', async () => {
  const snapshot = {
    venueName: 'Away Ground',
    mapLoaded: true,
    clickable: [{ id: '900', label: '22,24' }],
    mapLabels: ['22,24', '27,28'],
  };
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeSectionPage(snapshot)]),
  });

  const result = await svc.discoverEventMap('42', {
    name: 'משחק חוץ',
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=7000',
  });

  assert.equal(result.eventId, '7000');
  assert.equal(result.gameName, 'משחק חוץ');
  assert.equal(result.venueName, 'Away Ground');
  assert.equal(result.confidence, 'complete');
  assert.deepEqual(result.areas.map(({ id, label, available }) => ({ id, label, available })), [
    { id: '900', label: '22,24', available: true },
    { id: null, label: '27,28', available: false },
  ]);
});

test('discoverEventMap reports partial when only clickable controls are exposed', async () => {
  const snapshot = {
    venueName: null,
    mapLoaded: true,
    clickable: [{ id: '900', label: '22,24' }],
    mapLabels: [],
  };
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeSectionPage(snapshot)]),
  });

  const result = await svc.discoverEventMap('42', {
    name: 'Away',
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=7000',
  });

  assert.equal(result.confidence, 'partial');
  assert.deepEqual(result.areas.map(area => area.label), ['22,24']);
});

test('discoverEventMap excludes numbered box captions from stadium areas', async () => {
  const snapshot = {
    venueName: null,
    mapLoaded: true,
    clickable: [{ id: '900', label: '22,24' }],
    mapLabels: ['22,24', 'BOX1 | BOX2'],
  };
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeSectionPage(snapshot)]),
  });

  const result = await svc.discoverEventMap('42', {
    name: 'Away',
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=7000',
  });

  assert.deepEqual(result.areas.map(area => area.label), ['22,24']);
});

test('discoverEventMap reports unknown when no areas can be read', async () => {
  const snapshot = { venueName: null, mapLoaded: false, clickable: [], mapLabels: [] };
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeSectionPage(snapshot)]),
  });

  const result = await svc.discoverEventMap('42', {
    name: 'Away',
    url: 'https://tickets.mhaifafc.com/event/away',
  });

  assert.equal(result.eventId, null);
  assert.equal(result.confidence, 'unknown');
  assert.deepEqual(result.areas, []);
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

test('event redirect to the ticket-site login prompt is reported as SESSION_EXPIRED', async () => {
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeSectionPage([], {
      url: 'https://tickets.mhaifafc.com/Home/Index?returnUrl=%2fStadium%2fIndex%3feventId%3d6220',
    })]),
  });

  await assert.rejects(
    () => svc.discoverSections('42', 'https://tickets.mhaifafc.com/Stadium/Index?eventId=6220'),
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
