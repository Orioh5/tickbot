const test = require('node:test');
const assert = require('node:assert/strict');

const Monitor = require('../monitor');

function settings(overrides = {}) {
  return {
    url: 'https://tickets.mhaifafc.com/event',
    sections: ['13'],
    intervalMs: 1,
    pauseOnHit: false,
    autoPurchase: false,
    ...overrides,
  };
}

test('refreshes for cart automation when legacy false finds a watched ticket', async () => {
  const monitor = new Monitor();
  let refreshReason = '';
  monitor.running = true;
  monitor.settings = { sections: ['116'], autoPurchase: false };
  monitor.sections = { 116: { status: 'unavailable' } };
  monitor._onclickIdToLabel = { 1648: '116' };
  monitor._fetchApiAvailability = async () => ({
    timestamp: null,
    sectors: [{ id: '1648', freeSeats: 1 }],
  });
  monitor._refreshDomAvailability = async reason => { refreshReason = reason; };

  await monitor._pollApiAvailability();

  assert.match(refreshReason, /auto-purchase/i);
});

test('re-prompts without an owner rejected by the ticketing site', async () => {
  const monitor = new Monitor();
  monitor.running = true;
  monitor.settings = {
    telegramToken: 'token',
    telegramChatId: '12345',
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=5989',
  };
  const prompts = [];
  let assignmentComplete = false;
  monitor._ownerSelector = {
    chooseOwner: async request => {
      prompts.push(request.candidates.map(candidate => candidate.key));
      return { status: 'selected', candidateKey: prompts.length === 1 ? '0' : '1' };
    },
  };
  monitor._ownerBrowser = {
    discover: async () => assignmentComplete ? { required: false } : ({
      required: true,
      candidates: [
        { key: '0', name: 'בעלים א', identifier: 'id-a' },
        { key: '1', name: 'בעלים ב', identifier: 'id-b' },
      ],
    }),
    apply: async (_page, candidate) => {
      if (candidate.key === '0') return { status: 'rejected', reason: 'not eligible' };
      assignmentComplete = true;
      return { status: 'assigned' };
    },
  };
  monitor._notify = async () => {};

  assert.deepEqual(await monitor._completeOwnerAssignments(), { status: 'complete' });
  assert.deepEqual(prompts, [['0', '1'], ['1']]);
});

test('assigns multiple tickets sequentially', async () => {
  const monitor = new Monitor();
  const prompts = [];
  let discoveryCount = 0;
  monitor._stopRequested = false;
  monitor._ownerSelectionAbort = new AbortController();
  monitor._ownerSelector = {
    chooseOwner: async request => {
      prompts.push(request.ticketNumber);
      return { status: 'selected', candidateKey: '0' };
    },
  };
  monitor._ownerBrowser = {
    discover: async () => (++discoveryCount <= 2 ? {
      required: true,
      candidates: [{ key: '0', name: 'בעלים א', identifier: `owner-${discoveryCount}` }],
    } : { required: false }),
    apply: async () => ({ status: 'assigned' }),
  };

  assert.deepEqual(await monitor._completeOwnerAssignments(), { status: 'complete' });
  assert.deepEqual(prompts, [1, 2]);
});

test('skips Telegram when the cart requires no owner assignment', async () => {
  const monitor = new Monitor();
  monitor._stopRequested = false;
  monitor._ownerSelectionAbort = new AbortController();
  monitor._ownerSelector = { chooseOwner: async () => assert.fail('must not prompt') };
  monitor._ownerBrowser = { discover: async () => ({ required: false }) };
  assert.deepEqual(await monitor._completeOwnerAssignments(), { status: 'complete' });
});

test('returns manual timeout without applying an owner', async () => {
  const monitor = new Monitor();
  let applyCalls = 0;
  monitor._stopRequested = false;
  monitor._ownerSelectionAbort = new AbortController();
  monitor._ownerSelector = { chooseOwner: async () => ({ status: 'timeout' }) };
  monitor._ownerBrowser = {
    discover: async () => ({
      required: true,
      candidates: [{ key: '0', name: 'בעלים א', identifier: 'owner-a' }],
    }),
    apply: async () => { applyCalls++; },
  };
  assert.deepEqual(
    await monitor._completeOwnerAssignments(),
    { status: 'manual', reason: 'timeout' }
  );
  assert.equal(applyCalls, 0);
});

test('stop aborts owner selection before a candidate can be applied', { timeout: 500 }, async () => {
  const monitor = new Monitor();
  let applyCalls = 0;
  let markSelectionStarted;
  const selectionStarted = new Promise(resolve => { markSelectionStarted = resolve; });
  monitor.running = true;
  monitor._stopRequested = false;
  monitor._ownerSelectionAbort = new AbortController();
  monitor._ownerSelector = {
    chooseOwner: ({ signal }) => new Promise(resolve => {
      markSelectionStarted();
      signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
    }),
  };
  monitor._ownerBrowser = {
    discover: async () => ({
      required: true,
      candidates: [{ key: '0', name: 'בעלים א', identifier: 'owner-a' }],
    }),
    apply: async () => { applyCalls++; },
  };

  const flow = monitor._completeOwnerAssignments();
  await selectionStarted;
  await monitor.stop();
  assert.deepEqual(await flow, { status: 'manual', reason: 'cancelled' });
  assert.equal(applyCalls, 0);
});

test('start rejects while an owner flow is active without replacing its resources', async () => {
  const monitor = new Monitor();
  const browser = { close: async () => {} };
  const abort = new AbortController();
  const selector = { chooseOwner: async () => ({ status: 'timeout' }) };
  let launches = 0;
  monitor.running = false;
  monitor._phase = 'owner-selection';
  monitor.browser = browser;
  monitor._ownerSelectionAbort = abort;
  monitor._ownerSelector = selector;
  monitor._launch = async () => { launches++; };
  monitor._runLoop = async () => {};

  await assert.rejects(monitor.start(settings()), /busy|active/i);

  assert.equal(launches, 0);
  assert.equal(monitor.browser, browser);
  assert.equal(monitor._ownerSelectionAbort, abort);
  assert.equal(monitor._ownerSelector, selector);
});

test('restart stays blocked after Stop until the previous browser loop has fully unwound', async () => {
  const monitor = new Monitor();
  let releaseLoop;
  const loopGate = new Promise(resolve => { releaseLoop = resolve; });
  let launches = 0;
  monitor._launch = async () => {
    launches++;
    monitor.browser = { close: async () => {} };
  };
  monitor._runLoop = async () => loopGate;

  await monitor.start(settings());
  await monitor.stop();

  assert.equal(monitor.getStatus().busy, true);
  assert.equal(monitor.getStatus().phase, 'stopping');
  await assert.rejects(monitor.start(settings()), /busy|active/i);
  assert.equal(launches, 1);

  releaseLoop();
  await monitor._loopPromise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitor.getStatus().busy, false);
  assert.equal(monitor.getStatus().phase, 'stopped');
});

test('Stop during launch keeps restart blocked and cleans the stale launch before stopping', async () => {
  const monitor = new Monitor();
  let releaseLaunch;
  const launchGate = new Promise(resolve => { releaseLaunch = resolve; });
  let loopCalls = 0;
  let browserCloses = 0;
  const launchedBrowser = { close: async () => { browserCloses++; } };
  monitor._launch = async () => {
    await launchGate;
    monitor.browser = launchedBrowser;
    monitor.context = { flow: 'stale-launch' };
    monitor.page = { flow: 'stale-launch' };
  };
  monitor._runLoop = async () => { loopCalls++; };

  const firstStart = monitor.start(settings());
  assert.equal(monitor.getStatus().phase, 'starting');
  await monitor.stop();

  assert.equal(monitor.getStatus().busy, true);
  assert.equal(monitor.getStatus().phase, 'stopping');
  await assert.rejects(monitor.start(settings()), /busy|active/i);

  releaseLaunch();
  await firstStart;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(loopCalls, 0);
  assert.equal(browserCloses, 1);
  assert.equal(monitor.browser, null);
  assert.equal(monitor.context, null);
  assert.equal(monitor.page, null);
  assert.equal(monitor.getStatus().busy, false);
  assert.equal(monitor.getStatus().phase, 'stopped');
});

test('stop cancels Telegram and closes the active browser while owner selection is busy', { timeout: 500 }, async () => {
  const monitor = new Monitor();
  let closed = 0;
  let applyCalls = 0;
  let selectionStarted;
  const started = new Promise(resolve => { selectionStarted = resolve; });
  monitor.running = false;
  monitor._phase = 'owner-selection';
  monitor.browser = { close: async () => { closed++; } };
  monitor._stopRequested = false;
  monitor._ownerSelectionAbort = new AbortController();
  monitor._ownerSelector = {
    chooseOwner: ({ signal }) => new Promise(resolve => {
      selectionStarted();
      signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
    }),
  };
  monitor._ownerBrowser = {
    discover: async () => ({
      required: true,
      candidates: [{ key: 'a', name: 'בעלים א', identifier: 'owner-ref-a' }],
    }),
    apply: async () => { applyCalls++; },
  };

  assert.deepEqual(monitor.getStatus(), {
    running: false,
    busy: true,
    phase: 'owner-selection',
    startedAt: null,
    lastCheck: null,
  });
  const flow = monitor._completeOwnerAssignments();
  await started;
  await monitor.stop();

  assert.deepEqual(await flow, { status: 'manual', reason: 'cancelled' });
  assert.equal(applyCalls, 0);
  assert.equal(closed, 1);
  assert.equal(monitor.getStatus().busy, false);
  assert.equal(monitor.getStatus().phase, 'stopped');
});

test('a selection resolved during stop is never applied', async () => {
  const monitor = new Monitor();
  let applyCalls = 0;
  monitor.running = true;
  monitor._stopRequested = false;
  monitor._ownerSelectionAbort = new AbortController();
  monitor._ownerSelector = {
    chooseOwner: async () => {
      await monitor.stop();
      return { status: 'selected', candidateKey: '0' };
    },
  };
  monitor._ownerBrowser = {
    discover: async () => ({
      required: true,
      candidates: [{ key: '0', name: 'בעלים א', identifier: 'owner-a' }],
    }),
    apply: async () => {
      applyCalls++;
      return { status: 'assigned' };
    },
  };

  assert.deepEqual(
    await monitor._completeOwnerAssignments(),
    { status: 'manual', reason: 'cancelled' }
  );
  assert.equal(applyCalls, 0);
});

test('checkout notification contains no owner identifier', async () => {
  const monitor = new Monitor();
  const selectorRequests = [];
  const notifications = [];
  let discoveryCount = 0;
  monitor.settings = {
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=5989',
    loginUrl: 'https://auth.mhaifafc.com/',
  };
  monitor._stopRequested = false;
  monitor._ownerSelectionAbort = new AbortController();
  monitor._ownerSelector = {
    chooseOwner: async request => {
      selectorRequests.push(request);
      return { status: 'selected', candidateKey: '1' };
    },
  };
  monitor._ownerBrowser = {
    discover: async () => (++discoveryCount === 1 ? {
      required: true,
      candidates: [
        { key: '0', name: 'בעלים א', identifier: '000000001', ticketKey: 'private-ticket-a' },
        { key: '1', name: 'בעלים ב', identifier: '000000002', ticketKey: 'private-ticket-a' },
      ],
    } : { required: false }),
    apply: async () => ({ status: 'assigned' }),
  };
  monitor._notify = async (message, options) => {
    notifications.push(Monitor.buildNotificationText(monitor.settings, message, options));
    return true;
  };

  assert.deepEqual(await monitor._finishCartOwnerFlow(), { status: 'complete' });
  assert.deepEqual(selectorRequests[0].candidates, [
    { key: '0', name: 'בעלים א' },
    { key: '1', name: 'בעלים ב' },
  ]);
  assert.match(notifications[0], /\/Transaction2\/Edit/);
  assert.doesNotMatch(JSON.stringify(selectorRequests), /000000001|000000002/);
  assert.doesNotMatch(JSON.stringify(selectorRequests), /private-ticket-a/);
  assert.doesNotMatch(notifications.join('\n'), /000000001|000000002/);
});

test('returns false when Telegram notification configuration is unavailable', async () => {
  const monitor = new Monitor();
  monitor.settings = {
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=5989',
    loginUrl: 'https://auth.mhaifafc.com/',
    telegramToken: '',
    telegramChatId: '',
  };

  assert.equal(await monitor._notify('manual recovery'), false);
});

test('returns false when Telegram rejects a notification request', async () => {
  const monitor = new Monitor({
    notificationFetch: async () => ({
      ok: false,
      statusText: 'Bad Request',
      json: async () => ({ description: 'request rejected' }),
    }),
  });
  monitor.settings = {
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=5989',
    loginUrl: 'https://auth.mhaifafc.com/',
    telegramToken: 'test-token',
    telegramChatId: '12345',
  };

  assert.equal(await monitor._notify('manual recovery'), false);
});

test('emits the complete cart recovery message on the dashboard when Telegram delivery fails', async () => {
  const monitor = new Monitor();
  const logs = [];
  const alerts = [];
  monitor.settings = {
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=5989',
    loginUrl: 'https://auth.mhaifafc.com/',
    telegramToken: '',
    telegramChatId: '',
  };
  monitor._completeOwnerAssignments = async () => ({ status: 'manual', reason: 'error' });
  monitor.on('log', message => logs.push(message));
  monitor.on('alert', message => alerts.push(message));

  assert.deepEqual(
    await monitor._finishCartOwnerFlow(),
    { status: 'manual', reason: 'error' }
  );

  const expected = Monitor.buildNotificationText(
    monitor.settings,
    '⚠️ לא ניתן להשלים את השיוך אוטומטית. יש להשלים ידנית בסל.',
    { checkoutReady: true }
  );
  assert.equal(alerts.at(-1), expected);
  assert.equal(logs.at(-1), expected);
  assert.match(expected, /https:\/\/tickets\.mhaifafc\.com\/Transaction2\/Edit/);
});

test('emits the cart recovery URL when configured Telegram returns an API failure', async () => {
  const monitor = new Monitor({
    notificationFetch: async () => ({
      ok: false,
      statusText: 'Bad Request',
      json: async () => ({ description: 'request rejected' }),
    }),
  });
  const alerts = [];
  monitor.settings = {
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=5989',
    loginUrl: 'https://auth.mhaifafc.com/',
    telegramToken: 'test-token',
    telegramChatId: '12345',
  };
  monitor._completeOwnerAssignments = async () => ({ status: 'manual', reason: 'error' });
  monitor.on('alert', message => alerts.push(message));

  await monitor._finishCartOwnerFlow();

  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /https:\/\/tickets\.mhaifafc\.com\/Transaction2\/Edit/);
});

test('monitor uses one initial page load and then polls the API without reloading', async () => {
  const monitor = new Monitor();
  let domChecks = 0;
  let apiChecks = 0;
  let reloads = 0;

  monitor.running = true;
  monitor.settings = settings();
  monitor.page = {
    goto: async () => {},
    reload: async () => { reloads++; },
  };
  monitor._sleep = async () => {};
  monitor._checkAvailability = async () => {
    domChecks++;
    if (domChecks === 2) monitor.running = false;
  };
  monitor._pollApiOrFallback = async () => {
    apiChecks++;
    monitor.running = false;
  };

  await monitor._runLoop();

  assert.equal(domChecks, 1);
  assert.equal(apiChecks, 1);
  assert.equal(reloads, 0);
});

test('fetches sectors info for the event ID using the authenticated browser context', async () => {
  const monitor = new Monitor();
  let requestedUrl;
  let requestedOptions;

  monitor.settings = settings({
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=6121',
  });
  monitor.context = {
    request: {
      post: async (url, options) => {
        requestedUrl = url;
        requestedOptions = options;
        return {
          ok: () => true,
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json; charset=utf-8' }),
          text: async () => JSON.stringify({
            sectors: [{
              id: 1648,
              freeSeatsByPriceArea: [{ priceAreaId: 22, freeSeatsNo: 1 }],
            }],
            timestamp: '2026-08-03T17:41:25.5848207',
          }),
          json: async () => ({
            sectors: [{
              id: 1648,
              freeSeatsByPriceArea: [{ priceAreaId: 22, freeSeatsNo: 1 }],
            }],
            timestamp: '2026-08-03T17:41:25.5848207',
          }),
        };
      },
    },
  };

  const result = await monitor._fetchApiAvailability();

  assert.equal(
    requestedUrl,
    'https://tickets.mhaifafc.com/Stadium/GetWGLSectorsInfo?eventId=6121'
  );
  assert.equal(requestedOptions.headers.Referer, monitor.settings.url);
  assert.equal(requestedOptions.headers.Origin, 'https://tickets.mhaifafc.com');
  assert.deepEqual(result.sectors, [{ id: '1648', freeSeats: 1 }]);
});

test('reports an empty successful sectors response without a JSON parser error', async () => {
  const monitor = new Monitor();
  monitor.settings = settings({
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=6121',
  });
  monitor.context = {
    request: {
      post: async () => ({
        ok: () => true,
        status: () => 200,
        headers: () => ({ 'content-type': 'application/json; charset=utf-8' }),
        text: async () => '',
        json: async () => JSON.parse(''),
      }),
    },
  };

  await assert.rejects(
    monitor._fetchApiAvailability(),
    /Sectors API returned an empty response \(HTTP 200\)/
  );
});

test('API polling refreshes the DOM before cart automation for a newly available mapped section', async () => {
  const monitor = new Monitor();
  const notifications = [];
  let reloads = 0;
  let domChecks = 0;

  monitor.running = true;
  monitor.settings = settings({ sections: ['116'] });
  monitor.sections = { 116: { status: 'unavailable' } };
  monitor._onclickIdToLabel = { 1648: '116' };
  monitor._fetchApiAvailability = async () => ({
    timestamp: '2026-08-03T17:41:25.5848207',
    sectors: [{ id: '1648', freeSeats: 1 }],
  });
  monitor.page = { reload: async () => { reloads++; } };
  monitor._sleep = async () => {};
  monitor._checkAvailability = async () => { domChecks++; };
  monitor._notify = async message => notifications.push(message);

  await monitor._pollApiOrFallback();

  assert.equal(reloads, 1);
  assert.equal(domChecks, 1);
  assert.equal(monitor.sections[116].status, 'unavailable');
  assert.equal(notifications.length, 0);
});

test('API polling refreshes the DOM once when an available internal ID is not mapped', async () => {
  const monitor = new Monitor();
  let reloads = 0;
  let domChecks = 0;

  monitor.running = true;
  monitor.settings = settings({ sections: ['116'] });
  monitor._onclickIdToLabel = {};
  monitor._fetchApiAvailability = async () => ({
    timestamp: null,
    sectors: [{ id: '1648', freeSeats: 1 }],
  });
  monitor.page = { reload: async () => { reloads++; } };
  monitor._sleep = async () => {};
  monitor._checkAvailability = async () => { domChecks++; };

  await monitor._pollApiOrFallback();

  assert.equal(reloads, 1);
  assert.equal(domChecks, 1);
});

test('API polling falls back to one DOM refresh when the request fails', async () => {
  const monitor = new Monitor();
  let reloads = 0;
  let domChecks = 0;

  monitor.running = true;
  monitor.settings = settings();
  monitor._fetchApiAvailability = async () => {
    throw new Error('session expired');
  };
  monitor.page = { reload: async () => { reloads++; } };
  monitor._sleep = async () => {};
  monitor._checkAvailability = async () => { domChecks++; };

  await monitor._pollApiOrFallback();

  assert.equal(reloads, 1);
  assert.equal(domChecks, 1);
});

test('start rejects when the browser cannot be launched', async () => {
  const monitor = new Monitor();
  monitor._launch = async () => {
    throw new Error('Chromium unavailable');
  };

  await assert.rejects(monitor.start(settings()), /Chromium unavailable/);
  assert.equal(monitor.running, false);
});

test('monitoring loop closes the browser when monitoring stops itself', async () => {
  const monitor = new Monitor();
  let closed = 0;

  monitor.running = true;
  monitor.settings = settings();
  monitor.browser = {
    close: async () => { closed++; },
  };
  monitor.context = {};
  monitor.page = { goto: async () => {} };
  monitor._sleep = async () => {};
  monitor._checkAvailability = async () => {
    monitor.running = false;
  };

  await monitor._runLoop();

  assert.equal(closed, 1);
  assert.equal(monitor.browser, null);
  assert.equal(monitor.context, null);
  assert.equal(monitor.page, null);
});

test('stop closes an orphaned browser even if running is already false', async () => {
  const monitor = new Monitor();
  let closed = 0;

  monitor.running = false;
  monitor.browser = {
    close: async () => { closed++; },
  };

  await monitor.stop();

  assert.equal(closed, 1);
  assert.equal(monitor.browser, null);
});

test('manual stop and loop shutdown close the same browser only once', async () => {
  const monitor = new Monitor();
  let closed = 0;

  monitor.running = true;
  monitor.settings = settings();
  monitor.browser = {
    close: async () => { closed++; },
  };
  monitor.context = {};
  monitor.page = { goto: async () => {} };
  monitor._sleep = async () => {};
  monitor._checkAvailability = async () => {
    await monitor.stop();
  };

  await monitor._runLoop();

  assert.equal(closed, 1);
});
