'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const UserStore = require('../bot/user-store');
const SecureLoginService = require('../bot/secure-login-service');

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
        login: async () => {
          calls.push('authenticate');
          return { cookies: [{ name: 's', value: 'x' }], origins: [] };
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
  assert.deepEqual(calls, ['authenticate', 'redeem', 'save', 'notify:42']);
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

test('a successfully redeemed token rejects a second successful submission', async () => {
  const calls = [];
  let used = false;
  const app = createApp({
    botServices: {
      maccabiAuthenticator: {
        login: async () => {
          calls.push('authenticate');
          return { cookies: [], origins: [] };
        },
      },
      secureLoginService: {
        verifyToken: () => {
          if (used) throw new Error('Login link already used');
          return '42';
        },
        redeemToken: () => {
          if (used) throw new Error('Login link already used');
          used = true;
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
  const form = { t: 'token', username: 'u', password: 'p' };

  const firstResponse = await postForm(app, '/bot-login', form);
  const secondResponse = await postForm(app, '/bot-login', form);

  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 400);
  assert.deepEqual(calls, ['authenticate', 'redeem', 'save', 'notify']);
});

test('redemption failure after authentication is a token conflict and does not save or notify', async () => {
  const calls = [];
  const app = createApp({
    botServices: {
      maccabiAuthenticator: {
        login: async () => {
          calls.push('authenticate');
          return { cookies: [], origins: [] };
        },
      },
      secureLoginService: {
        verifyToken: () => '42',
        redeemToken: () => {
          calls.push('redeem');
          throw new Error('internal token detail');
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

  const response = await postForm(app, '/bot-login', {
    t: 'sensitive-token',
    username: 'u',
    password: 'p',
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(calls, ['authenticate', 'redeem']);
  assert.doesNotMatch(response.body, /internal token detail|sensitive-token/);
});

test('token user mismatch is a conflict and does not save or notify', async () => {
  const calls = [];
  const app = createApp({
    botServices: {
      maccabiAuthenticator: {
        login: async () => {
          calls.push('authenticate');
          return { cookies: [], origins: [] };
        },
      },
      secureLoginService: {
        verifyToken: () => '42',
        redeemToken: () => {
          calls.push('redeem');
          return '99';
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

  const response = await postForm(app, '/bot-login', {
    t: 'token',
    username: 'u',
    password: 'p',
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(calls, ['authenticate', 'redeem']);
});

test('session persistence failure requires a new login link and does not notify', async () => {
  const calls = [];
  const app = createApp({
    botServices: {
      maccabiAuthenticator: {
        login: async () => {
          calls.push('authenticate');
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
        save: async () => {
          calls.push('save');
          throw new Error('filesystem secret detail');
        },
      },
      loginNotifier: {
        loginSucceeded: async () => { calls.push('notify'); },
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

    assert.equal(response.statusCode, 500);
    assert.deepEqual(calls, ['authenticate', 'redeem', 'save']);
    assert.match(response.body, /קישור חדש/);
    assert.doesNotMatch(response.body, /אותו קישור|filesystem secret detail/);
  } finally {
    console.error = originalConsoleError;
  }
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

test('revocation during Playwright login prevents the session from being recreated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhfc-revoke-during-login-'));
  const store = new UserStore({ dbPath: path.join(root, 'bot.db') });
  store.createUser({ telegramUserId: '42' });
  const secureLoginService = new SecureLoginService({
    userStore: store,
    baseUrl: 'https://example.test',
    randomBytes: size => Buffer.alloc(size, 0xcd),
    now: () => 100,
  });
  const rawToken = new URL(secureLoginService.createLoginLink('42')).searchParams.get('t');
  const saved = [];
  const notified = [];
  let signalAuthenticationStarted;
  let releaseAuthentication;
  const authenticationStarted = new Promise(resolve => { signalAuthenticationStarted = resolve; });
  const authenticationGate = new Promise(resolve => { releaseAuthentication = resolve; });
  const app = createApp({
    botServices: {
      maccabiAuthenticator: {
        login: async () => {
          signalAuthenticationStarted();
          await authenticationGate;
          return { cookies: [{ name: 'sid', value: 'secret' }], origins: [] };
        },
      },
      secureLoginService,
      userSessionStore: {
        save: (userId, storageState) => saved.push({ userId, storageState }),
      },
      loginNotifier: {
        loginSucceeded: async userId => notified.push(userId),
      },
    },
  });

  try {
    const request = postForm(app, '/bot-login', {
      t: rawToken,
      username: 'u',
      password: 'p',
    });
    await authenticationStarted;
    store.revokeUser('42');
    releaseAuthentication();
    const response = await request;

    assert.equal(response.statusCode, 409);
    assert.deepEqual(saved, []);
    assert.deepEqual(notified, []);
    assert.equal(store.getUser('42').revoked, 1);
  } finally {
    releaseAuthentication?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
