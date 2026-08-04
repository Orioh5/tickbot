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
