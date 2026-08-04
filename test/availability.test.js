const test = require('node:test');
const assert = require('node:assert/strict');

const Monitor = require('../monitor');

test('builds the sectors-info API URL from any configured event ID', () => {
  assert.equal(
    Monitor.buildSectorsInfoUrl('https://tickets.mhaifafc.com/Stadium/Index?eventId=6121'),
    'https://tickets.mhaifafc.com/Stadium/GetWGLSectorsInfo?eventId=6121'
  );
});

test('parses free-seat totals across all price areas', () => {
  const result = Monitor.parseSectorsInfo({
    sectors: [
      {
        id: 1648,
        freeSeatsByPriceArea: [
          { priceAreaId: 21, freeSeatsNo: 2 },
          { priceAreaId: 22, freeSeatsNo: 3 },
        ],
      },
      { id: 1650, freeSeatsByPriceArea: [] },
    ],
    timestamp: '2026-08-03T17:41:25.5848207',
  });

  assert.deepEqual(result, {
    timestamp: '2026-08-03T17:41:25.5848207',
    sectors: [
      { id: '1648', freeSeats: 5 },
      { id: '1650', freeSeats: 0 },
    ],
  });
});

test('adds a direct cart link when tickets were added automatically', () => {
  const text = Monitor.buildNotificationText(
    {
      url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=5989',
      loginUrl: 'https://auth.mhaifafc.com/',
    },
    'Tickets added to cart',
    { checkoutReady: true }
  );

  assert.match(text, /https:\/\/tickets\.mhaifafc\.com\/Transaction2\/Edit/);
  assert.match(text, /eventId=5989/);
});

test('parses visual section labels and internal onclick IDs from page candidates', () => {
  const result = Monitor.parseAvailableSections([
    { onclick: 'stadium.processSectorById(1590)', text: 'גוש 13' },
    { onclick: 'stadium.processSectorById(1591)', text: 'גוש 14' },
    { onclick: 'notASection()', text: 'גוש 15' },
  ]);

  assert.deepEqual(result, [
    { id: '1590', label: '13' },
    { id: '1591', label: '14' },
  ]);
});

test('does not mark sections sold out when the seat map has not loaded', async () => {
  const monitor = new Monitor();
  let evaluations = 0;

  monitor.running = true;
  monitor.settings = {
    sections: ['13'],
    pauseOnHit: false,
    autoPurchase: false,
  };
  monitor.sections = { 13: { status: 'pending' } };
  monitor.page = {
    evaluate: async () => (++evaluations === 1 ? false : []),
  };

  await assert.rejects(monitor._checkAvailability(), /seat map/i);
  assert.deepEqual(monitor.sections, { 13: { status: 'pending' } });
  assert.equal(monitor.stats.checks, 0);
});

test('notifies only once while a section remains available', async () => {
  const monitor = new Monitor();
  const notifications = [];
  const results = [
    false,
    { mapLoaded: true, candidates: [{ onclick: 'processSectorById(1590)', text: 'גוש 13' }] },
    false,
    { mapLoaded: true, candidates: [{ onclick: 'processSectorById(1590)', text: 'גוש 13' }] },
  ];

  monitor.running = true;
  monitor.settings = {
    sections: ['13'],
    pauseOnHit: false,
    autoPurchase: false,
  };
  monitor.sections = { 13: { status: 'pending' } };
  monitor.page = { evaluate: async () => results.shift() };
  monitor._notify = async message => notifications.push(message);
  monitor._tryAutoPurchase = async () => ({ cartReady: false, assignments: 'failed' });

  await monitor._checkAvailability();
  await monitor._checkAvailability();

  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /available/i);
  assert.equal(monitor.stats.alerts, 1);
});

test('Queue-it sends one notification per continuous queue incident', async () => {
  const monitor = new Monitor();
  const notifications = [];

  monitor.running = true;
  monitor.settings = { sections: ['13'] };
  monitor.page = { evaluate: async () => true };
  monitor._notify = async message => notifications.push(message);

  await monitor._checkAvailability();
  await monitor._checkAvailability();

  assert.equal(notifications.length, 1);
});

test('Queue-it can notify again after the previous queue incident clears', async () => {
  const monitor = new Monitor();
  const notifications = [];
  const results = [
    true,
    false,
    { mapLoaded: true, candidates: [] },
    true,
  ];

  monitor.running = true;
  monitor.settings = { sections: ['13'], pauseOnHit: false, autoPurchase: false };
  monitor.sections = { 13: { status: 'pending' } };
  monitor.page = { evaluate: async () => results.shift() };
  monitor._notify = async message => notifications.push(message);

  await monitor._checkAvailability();
  await monitor._checkAvailability();
  await monitor._checkAvailability();

  assert.equal(notifications.length, 2);
});

test('notifies when previously available sections become unavailable', async () => {
  const monitor = new Monitor();
  const notifications = [];
  const results = [
    false,
    { mapLoaded: true, candidates: [] },
  ];

  monitor.running = true;
  monitor.settings = { sections: ['13'], pauseOnHit: false, autoPurchase: false };
  monitor.sections = { 13: { status: 'available' } };
  monitor.page = { evaluate: async () => results.shift() };
  monitor._notify = async message => notifications.push(message);

  await monitor._checkAvailability();

  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /no longer available/i);
  assert.equal(monitor.sections[13].status, 'unavailable');
});

test('auto-purchase opens the cart and returns the completed owner-assignment result', async () => {
  const monitor = new Monitor();
  const navigations = [];
  let ownerFlowCalls = 0;
  const statusPhases = [];

  monitor.running = true;
  monitor.settings = {
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=5989',
    desiredQuantity: 1,
  };
  monitor.page = {
    $: async () => ({ click: async () => {} }),
    waitForSelector: async () => {},
    click: async () => {},
    goto: async url => { navigations.push(url); },
    url: () => 'https://tickets.mhaifafc.com/Transaction2/Edit',
    locator: selector => {
      assert.equal(selector, '.transaction-ticket');
      return { count: async () => 1 };
    },
  };
  monitor._sleep = async () => {};
  monitor._finishCartOwnerFlow = async () => {
    ownerFlowCalls++;
    assert.equal(monitor.running, false);
    return { status: 'complete' };
  };
  monitor.on('status', status => { statusPhases.push(status.phase); });

  assert.deepEqual(await monitor._tryAutoPurchase('13'), {
    cartReady: true,
    assignments: 'complete',
  });
  assert.deepEqual(navigations, ['https://tickets.mhaifafc.com/Transaction2/Edit']);
  assert.equal(ownerFlowCalls, 1);
  assert.deepEqual(statusPhases, ['cart-interaction', 'owner-selection']);
});

function makeCartPage({ finalUrl, ticketCount, incrementFails = false }) {
  let selectedSection = false;
  let confirmed = false;
  let increments = 0;
  let currentUrl = 'https://tickets.mhaifafc.com/Stadium/Index?eventId=5989';
  return {
    state: () => ({ selectedSection, confirmed, increments, currentUrl }),
    page: {
      $: async () => ({ click: async () => { selectedSection = true; } }),
      waitForSelector: async () => {},
      click: async selector => {
        if (selector.includes('has-text("+")')) {
          increments++;
          if (incrementFails) throw new Error('quantity increment failed');
          return;
        }
        confirmed = true;
      },
      goto: async () => { currentUrl = finalUrl; },
      url: () => currentUrl,
      locator: selector => {
        assert.equal(selector, '.transaction-ticket');
        return { count: async () => ticketCount };
      },
    },
  };
}

async function runCartVerificationCase({ desiredQuantity, finalUrl, ticketCount, incrementFails }) {
  const monitor = new Monitor();
  const cart = makeCartPage({ finalUrl, ticketCount, incrementFails });
  let ownerFlowCalls = 0;
  monitor.running = true;
  monitor._phase = 'monitoring';
  monitor.settings = {
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=5989',
    loginUrl: 'https://auth.mhaifafc.com/',
    desiredQuantity,
  };
  monitor.page = cart.page;
  monitor._sleep = async () => {};
  monitor._finishCartOwnerFlow = async () => {
    ownerFlowCalls++;
    return { status: 'complete' };
  };
  return {
    monitor,
    cart,
    ownerFlowCalls: () => ownerFlowCalls,
    result: await monitor._tryAutoPurchase('13'),
  };
}

test('does not accept an empty cart as a no-owner-required cart', async () => {
  const run = await runCartVerificationCase({
    desiredQuantity: 1,
    finalUrl: 'https://tickets.mhaifafc.com/Transaction2/Edit',
    ticketCount: 0,
  });
  assert.deepEqual(run.result, { cartReady: false, assignments: 'failed' });
  assert.equal(run.ownerFlowCalls(), 0);
});

test('does not accept a home redirect as a ready cart', async () => {
  const run = await runCartVerificationCase({
    desiredQuantity: 1,
    finalUrl: 'https://tickets.mhaifafc.com/',
    ticketCount: 1,
  });
  assert.deepEqual(run.result, { cartReady: false, assignments: 'failed' });
  assert.equal(run.ownerFlowCalls(), 0);
});

test('does not accept fewer cart tickets than requested', async () => {
  const run = await runCartVerificationCase({
    desiredQuantity: 2,
    finalUrl: 'https://tickets.mhaifafc.com/Transaction2/Edit',
    ticketCount: 1,
  });
  assert.deepEqual(run.result, { cartReady: false, assignments: 'failed' });
  assert.equal(run.ownerFlowCalls(), 0);
});

test('fails cart insertion when a requested quantity increment fails', async () => {
  const run = await runCartVerificationCase({
    desiredQuantity: 2,
    finalUrl: 'https://tickets.mhaifafc.com/Transaction2/Edit',
    ticketCount: 1,
    incrementFails: true,
  });
  assert.deepEqual(run.result, { cartReady: false, assignments: 'failed' });
  assert.equal(run.ownerFlowCalls(), 0);
});

test('accepts a verified cart that validly requires no owner assignment', async () => {
  const monitor = new Monitor();
  const cart = makeCartPage({
    finalUrl: 'https://tickets.mhaifafc.com/Transaction2/Edit',
    ticketCount: 1,
  });
  let prompts = 0;
  monitor.running = true;
  monitor._phase = 'monitoring';
  monitor.settings = {
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=5989',
    loginUrl: 'https://auth.mhaifafc.com/',
    telegramToken: 'test-token',
    telegramChatId: '12345',
    desiredQuantity: 1,
  };
  monitor.page = cart.page;
  monitor._sleep = async () => {};
  monitor._ownerSelectionAbort = new AbortController();
  monitor._ownerSelector = { chooseOwner: async () => { prompts++; } };
  monitor._ownerBrowser = { discover: async () => ({ required: false }) };
  monitor._notify = async () => true;

  assert.deepEqual(await monitor._tryAutoPurchase('13'), {
    cartReady: true,
    assignments: 'complete',
  });
  assert.equal(prompts, 0);
});

test('auto-purchase returns a structured failure when the section cannot be clicked', async () => {
  const monitor = new Monitor();
  monitor.settings = { desiredQuantity: 1 };
  monitor.page = { $: async () => null };

  assert.deepEqual(await monitor._tryAutoPurchase('13'), {
    cartReady: false,
    assignments: 'failed',
  });
});

test('availability does not send a second Telegram alert after the cart owner flow', async () => {
  const monitor = new Monitor();
  const notifications = [];
  monitor.running = true;
  monitor.settings = {
    sections: ['13'],
    pauseOnHit: false,
    autoPurchase: true,
  };
  monitor.sections = { 13: { status: 'pending' } };
  monitor._notify = async message => { notifications.push(message); };
  monitor._tryAutoPurchase = async () => {
    await monitor._notify('✅ הסל מוכן לתשלום.');
    return { cartReady: true, assignments: 'complete' };
  };

  await monitor._applyAvailability([{ id: '1590', label: '13' }]);

  assert.deepEqual(notifications, ['✅ הסל מוכן לתשלום.']);
});

test('attempts cart insertion on a newly available watched section without an autoPurchase setting', async () => {
  const monitor = new Monitor();
  let attempted = '';
  monitor.running = true;
  monitor.settings = { sections: ['101'], pauseOnHit: false };
  monitor.sections = { 101: { status: 'unavailable' } };
  monitor._tryAutoPurchase = async section => {
    attempted = section;
    return { cartReady: true, assignments: 'complete' };
  };
  monitor._notify = async () => {};

  await monitor._applyAvailability([{ id: '1614', label: '101' }]);

  assert.equal(attempted, '101');
});
