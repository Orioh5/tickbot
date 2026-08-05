'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MaccabiAuthenticator = require('../bot/maccabi-authenticator');

function makeBrowser({ finalUrl, passwordFields = 0, storageState = { cookies: [], origins: [] } }) {
  const contextOptions = [];
  const page = {
    goto: async () => {},
    fill: async () => {},
    click: async () => {},
    waitForNavigation: async () => {},
    url: () => finalUrl,
    locator: () => ({ count: async () => passwordFields }),
  };
  const context = {
    newPage: async () => page,
    storageState: async () => storageState,
  };
  return {
    browser: { newContext: async options => { contextOptions.push(options); return context; }, close: async () => {} },
    page,
    contextOptions,
  };
}

test('rejects credentials when the login form is still present', async () => {
  const { browser } = makeBrowser({
    finalUrl: 'https://auth.mhaifafc.com/',
    passwordFields: 1,
  });
  const authenticator = new MaccabiAuthenticator({ browserFactory: async () => browser });
  await assert.rejects(
    () => authenticator.login('bad-user', 'bad-password'),
    /credentials were not accepted/i
  );
});

test('returns storageState only after the login form disappears', async () => {
  const expected = { cookies: [{ name: 'session', value: 'ok' }], origins: [] };
  const { browser } = makeBrowser({
    finalUrl: 'https://tickets.mhaifafc.com/',
    passwordFields: 0,
    storageState: expected,
  });
  const authenticator = new MaccabiAuthenticator({ browserFactory: async () => browser });
  assert.deepEqual(await authenticator.login('user', 'password'), expected);
});

test('opens the dedicated Maccabi Haifa login route', async () => {
  const visited = [];
  const { browser, page } = makeBrowser({
    finalUrl: 'https://tickets.mhaifafc.com/',
    passwordFields: 0,
    storageState: { cookies: [{ name: 'session', value: 'ok' }], origins: [] },
  });
  page.goto = async url => visited.push(url);
  const authenticator = new MaccabiAuthenticator({ browserFactory: async () => browser });
  await authenticator.login('user', 'password');
  assert.deepEqual(visited, ['https://auth.mhaifafc.com/login']);
});

test('uses a normal browser profile so CloudFront serves the login form', async () => {
  const { browser, contextOptions } = makeBrowser({
    finalUrl: 'https://tickets.mhaifafc.com/',
    passwordFields: 0,
    storageState: { cookies: [{ name: 'session', value: 'ok' }], origins: [] },
  });
  const authenticator = new MaccabiAuthenticator({ browserFactory: async () => browser });
  await authenticator.login('user', 'password');
  assert.match(contextOptions[0].userAgent, /Chrome\//);
  assert.equal(contextOptions[0].locale, 'he-IL');
});
