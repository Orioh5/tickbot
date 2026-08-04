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
        { key: '0', name: 'בעלים א', identifier: '000000001' },
        { key: '1', name: 'בעלים ב', identifier: '000000002' },
      ],
    } : { required: false }),
    apply: async () => ({ status: 'assigned' }),
  };
  monitor._notify = async (message, options) => {
    notifications.push(Monitor.buildNotificationText(monitor.settings, message, options));
  };

  assert.deepEqual(await monitor._finishCartOwnerFlow(), { status: 'complete' });
  assert.deepEqual(selectorRequests[0].candidates, [
    { key: '0', name: 'בעלים א' },
    { key: '1', name: 'בעלים ב' },
  ]);
  assert.match(notifications[0], /\/Transaction2\/Edit/);
  assert.doesNotMatch(JSON.stringify(selectorRequests), /000000001|000000002/);
  assert.doesNotMatch(notifications.join('\n'), /000000001|000000002/);
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
