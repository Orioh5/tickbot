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

test('API polling updates a mapped visual section without reloading the page', async () => {
  const monitor = new Monitor();
  const notifications = [];
  let reloads = 0;

  monitor.running = true;
  monitor.settings = settings({ sections: ['116'] });
  monitor.sections = { 116: { status: 'unavailable' } };
  monitor._onclickIdToLabel = { 1648: '116' };
  monitor._fetchApiAvailability = async () => ({
    timestamp: '2026-08-03T17:41:25.5848207',
    sectors: [{ id: '1648', freeSeats: 1 }],
  });
  monitor.page = { reload: async () => { reloads++; } };
  monitor._notify = async message => notifications.push(message);

  await monitor._pollApiOrFallback();

  assert.equal(reloads, 0);
  assert.equal(monitor.sections[116].status, 'available');
  assert.equal(monitor.sections[116].freeSeats, 1);
  assert.equal(notifications.length, 1);
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
