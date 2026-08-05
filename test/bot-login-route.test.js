'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Explicit values keep this test isolated from developer credentials in .env.
process.env.ENCRYPTION_KEY = 'bot-login-route-test-key';
process.env.APP_PASSWORD = 'bot-login-route-test-password';
process.env.SESSION_SECRET = 'bot-login-route-test-session-secret';
process.env.BOT_TOKEN = '';
process.env.TELEGRAM_TOKEN = '';
process.env.PORT = '0';

const serverModule = require('../server');
const { createApp } = serverModule;

test.after(() => {
  if (serverModule.server?.listening) serverModule.server.close();
});

test('importing the app factory does not start the production server', () => {
  assert.equal(serverModule.server, null);
});

async function postForm(app, pathname, fields) {
  const body = new URLSearchParams(fields).toString();
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const { port } = server.address();
    return await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      }, response => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { responseBody += chunk; });
        response.on('end', () => resolve({
          statusCode: response.statusCode,
          body: responseBody,
        }));
      });
      request.once('error', reject);
      request.end(body);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('verified login saves session then notifies Telegram', async () => {
  const calls = [];
  const app = createApp({
    botServices: {
      maccabiAuthenticator: {
        login: async () => ({ cookies: [{ name: 's', value: 'x' }], origins: [] }),
      },
      secureLoginService: {
        verifyToken: () => '42',
        redeemToken: () => '42',
      },
      userSessionStore: {
        save: async () => { calls.push('save'); },
      },
      loginNotifier: {
        loginSucceeded: async userId => { calls.push(`notify:${userId}`); },
      },
    },
  });

  const response = await postForm(app, '/bot-login', {
    t: 'token',
    username: 'u',
    password: 'p',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, ['save', 'notify:42']);
});

test('invalid credentials can retry the same token and do not save or notify', async () => {
  const calls = [];
  let loginAttempts = 0;
  const app = createApp({
    botServices: {
      maccabiAuthenticator: {
        login: async () => {
          loginAttempts += 1;
          if (loginAttempts === 1) throw new Error('invalid credentials');
          return { cookies: [], origins: [] };
        },
      },
      secureLoginService: {
        verifyToken: () => '42',
        redeemToken: () => {
          calls.push('redeem');
          return '42';
        },
      },
      userSessionStore: {
        save: async () => { calls.push('save'); },
      },
      loginNotifier: {
        loginSucceeded: async () => { calls.push('notify'); },
      },
    },
  });

  const firstResponse = await postForm(app, '/bot-login', {
    t: 'token',
    username: 'wrong',
    password: 'wrong',
  });

  assert.equal(firstResponse.statusCode, 401);
  assert.deepEqual(calls, []);

  const retryResponse = await postForm(app, '/bot-login', {
    t: 'token',
    username: 'u',
    password: 'p',
  });

  assert.equal(retryResponse.statusCode, 200);
  assert.deepEqual(calls, ['redeem', 'save', 'notify']);
});

test('Telegram notification failure does not fail a completed login', async () => {
  const calls = [];
  const app = createApp({
    botServices: {
      maccabiAuthenticator: {
        login: async () => ({ cookies: [], origins: [] }),
      },
      secureLoginService: {
        verifyToken: () => '42',
        redeemToken: () => '42',
      },
      userSessionStore: {
        save: async () => { calls.push('save'); },
      },
      loginNotifier: {
        loginSucceeded: async () => {
          calls.push('notify');
          throw new Error('Telegram unavailable');
        },
      },
    },
  });
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await postForm(app, '/bot-login', {
      t: 'token',
      username: 'u',
      password: 'p',
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, ['save', 'notify']);
  } finally {
    console.error = originalConsoleError;
  }
});
