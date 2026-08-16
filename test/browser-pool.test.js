'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BrowserPool = require('../bot/browser-pool');

test('concurrent leases share one browser and individual release keeps it alive', async () => {
  let launches = 0;
  let closes = 0;
  const browser = { close: async () => { closes++; } };
  const pool = new BrowserPool({
    launch: async () => {
      launches++;
      await new Promise(resolve => setImmediate(resolve));
      return browser;
    },
  });

  const [first, second] = await Promise.all([pool.acquire(), pool.acquire()]);

  assert.equal(launches, 1);
  assert.equal(first.browser, browser);
  assert.equal(second.browser, browser);
  await first.release();
  await second.release();
  assert.equal(closes, 0);

  await pool.close();
  assert.equal(closes, 1);
});

test('a disconnected shared browser is replaced on the next lease', async () => {
  const browsers = [
    { isConnected: () => false, close: async () => {} },
    { isConnected: () => true, close: async () => {} },
  ];
  let launches = 0;
  const pool = new BrowserPool({ launch: async () => browsers[launches++] });

  const first = await pool.acquire();
  await first.release();
  const second = await pool.acquire();

  assert.equal(launches, 2);
  assert.equal(second.browser, browsers[1]);
  await pool.close();
});
