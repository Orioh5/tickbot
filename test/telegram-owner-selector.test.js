const test = require('node:test');
const assert = require('node:assert/strict');
const TelegramOwnerSelector = require('../telegram-owner-selector');

test('sends owner names without identity data and returns the selected opaque key', async () => {
  const requests = [];
  const responses = [
    { ok: true, result: { message_id: 51 } },
    { ok: true, result: [{
      update_id: 90,
      callback_query: {
        id: 'callback-1',
        data: 'owner:fixednonce:b',
        message: { chat: { id: 12345 } },
      },
    }] },
    { ok: true, result: true },
  ];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    return { ok: true, json: async () => responses.shift() };
  };
  const selector = new TelegramOwnerSelector({
    token: 'test-token',
    chatId: '12345',
    fetchImpl,
    nonceFactory: () => 'fixednonce',
    now: () => 0,
  });

  const result = await selector.chooseOwner({
    ticketNumber: 1,
    candidates: [
      { key: 'a', name: 'בעלים א' },
      { key: 'b', name: 'בעלים ב' },
    ],
  });

  assert.deepEqual(result, { status: 'selected', candidateKey: 'b' });
  const sendBody = JSON.parse(requests[0].options.body);
  assert.deepEqual(sendBody.reply_markup.inline_keyboard, [
    [{ text: 'בעלים א', callback_data: 'owner:fixednonce:a' }],
    [{ text: 'בעלים ב', callback_data: 'owner:fixednonce:b' }],
  ]);
  assert.doesNotMatch(JSON.stringify(sendBody), /\d{9}/);
  assert.equal(requests.every(request => request.options.signal === requests[0].options.signal), true);
  assert.equal(requests[0].options.signal instanceof AbortSignal, true);
});

test('ignores foreign chat, stale nonce, and unknown candidate callbacks', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = url.split('/').pop();
    calls.push({ method, body: options.body ? JSON.parse(options.body) : {} });
    if (method === 'sendMessage') {
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 51 } }) };
    }
    if (method === 'getUpdates') {
      return { ok: true, json: async () => ({ ok: true, result: [
        { update_id: 1, callback_query: { id: 'foreign', data: 'owner:fixednonce:a', message: { chat: { id: 999 } } } },
        { update_id: 2, callback_query: { id: 'stale', data: 'owner:oldnonce:a', message: { chat: { id: 12345 } } } },
        { update_id: 3, callback_query: { id: 'unknown', data: 'owner:fixednonce:z', message: { chat: { id: 12345 } } } },
        { update_id: 4, callback_query: { id: 'accepted', data: 'owner:fixednonce:b', message: { chat: { id: 12345 } } } },
      ] }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: true }) };
  };
  const selector = new TelegramOwnerSelector({
    token: 'test-token', chatId: '12345', fetchImpl,
    nonceFactory: () => 'fixednonce', now: () => 0,
  });

  const result = await selector.chooseOwner({
    ticketNumber: 1,
    candidates: [{ key: 'a', name: 'בעלים א' }, { key: 'b', name: 'בעלים ב' }],
  });

  assert.deepEqual(result, { status: 'selected', candidateKey: 'b' });
  assert.deepEqual(
    calls.filter(call => call.method === 'answerCallbackQuery').map(call => call.body.callback_query_id),
    ['accepted']
  );
});

test('returns timeout when a poll returns a valid callback after 180000 ms', async () => {
  let clock = 0;
  const methods = [];
  const selector = new TelegramOwnerSelector({
    token: 'test-token', chatId: '12345',
    nonceFactory: () => 'fixednonce',
    now: () => clock,
    fetchImpl: async url => {
      const method = url.split('/').pop();
      methods.push(method);
      if (method === 'getUpdates') {
        clock = 180000;
        return { ok: true, json: async () => ({ ok: true, result: [{
          update_id: 1,
          callback_query: {
            id: 'late-callback',
            data: 'owner:fixednonce:a',
            message: { chat: { id: 12345 } },
          },
        }] }) };
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 51 } }) };
    },
  });
  assert.deepEqual(
    await selector.chooseOwner({ ticketNumber: 1, candidates: [{ key: 'a', name: 'בעלים א' }] }),
    { status: 'timeout' }
  );
  assert.deepEqual(methods, ['sendMessage', 'getUpdates']);
});

test('returns cancelled without applying a late callback', async () => {
  const controller = new AbortController();
  controller.abort();
  const methods = [];
  const selector = new TelegramOwnerSelector({
    token: 'test-token', chatId: '12345',
    fetchImpl: async url => {
      methods.push(url.split('/').pop());
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 51 } }) };
    },
  });
  assert.deepEqual(
    await selector.chooseOwner({
      ticketNumber: 1,
      candidates: [{ key: 'a', name: 'בעלים א' }],
      signal: controller.signal,
    }),
    { status: 'cancelled' }
  );
  assert.deepEqual(methods, []);
});

test('cancels an outstanding long poll and forwards its abort signal', async () => {
  const controller = new AbortController();
  let pollSignal;
  const selector = new TelegramOwnerSelector({
    token: 'test-token',
    chatId: '12345',
    now: () => 0,
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/sendMessage')) {
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 51 } }) };
      }
      pollSignal = options.signal;
      controller.abort();
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  });

  assert.deepEqual(
    await selector.chooseOwner({
      ticketNumber: 1,
      candidates: [{ key: 'a', name: 'בעלים א' }],
      signal: controller.signal,
    }),
    { status: 'cancelled' }
  );
  assert.equal(pollSignal.aborted, true);
});

test('returns an error result when Telegram rejects a request', async () => {
  const selector = new TelegramOwnerSelector({
    token: 'test-token',
    chatId: '12345',
    fetchImpl: async () => ({ ok: false, json: async () => ({ ok: false }) }),
  });

  assert.deepEqual(
    await selector.chooseOwner({
      ticketNumber: 1,
      candidates: [{ key: 'a', name: 'בעלים א' }],
    }),
    { status: 'error', message: 'Telegram sendMessage failed' }
  );
});

test('starts the deadline before sendMessage and times out a stalled send', { timeout: 5000 }, async () => {
  let sendSignal;
  const selector = new TelegramOwnerSelector({
    token: 'test-token',
    chatId: '12345',
    timeoutMs: 20,
    fetchImpl: async (_url, options = {}) => {
      sendSignal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });

  assert.deepEqual(
    await selector.chooseOwner({
      ticketNumber: 1,
      candidates: [{ key: 'a', name: 'בעלים א' }],
    }),
    { status: 'timeout' }
  );
  assert.equal(sendSignal.aborted, true);
});

test('returns cancelled when the caller aborts a stalled send', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const selector = new TelegramOwnerSelector({
    token: 'test-token',
    chatId: '12345',
    timeoutMs: 200,
    fetchImpl: async (_url, options = {}) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });

  const choice = selector.chooseOwner({
    ticketNumber: 1,
    candidates: [{ key: 'a', name: 'בעלים א' }],
    signal: controller.signal,
  });
  setImmediate(() => controller.abort());

  assert.deepEqual(await choice, { status: 'cancelled' });
});

test('times out when callback acknowledgement stalls', { timeout: 5000 }, async () => {
  const methods = [];
  const signals = [];
  const selector = new TelegramOwnerSelector({
    token: 'test-token',
    chatId: '12345',
    nonceFactory: () => 'fixednonce',
    timeoutMs: 20,
    fetchImpl: async (url, options = {}) => {
      const method = url.split('/').pop();
      methods.push(method);
      signals.push(options.signal);
      if (method === 'sendMessage') {
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 51 } }) };
      }
      if (method === 'getUpdates') {
        return { ok: true, json: async () => ({ ok: true, result: [{
          update_id: 1,
          callback_query: {
            id: 'callback-1',
            data: 'owner:fixednonce:a',
            message: { chat: { id: 12345 } },
          },
        }] }) };
      }
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });

  assert.deepEqual(
    await selector.chooseOwner({
      ticketNumber: 1,
      candidates: [{ key: 'a', name: 'בעלים א' }],
    }),
    { status: 'timeout' }
  );
  assert.deepEqual(methods, ['sendMessage', 'getUpdates', 'answerCallbackQuery']);
  assert.equal(signals.every(signal => signal === signals[0]), true);
});

test('does not select when acknowledgement completes at the deadline', async () => {
  let clock = 0;
  const selector = new TelegramOwnerSelector({
    token: 'test-token',
    chatId: '12345',
    nonceFactory: () => 'fixednonce',
    now: () => clock,
    fetchImpl: async url => {
      const method = url.split('/').pop();
      if (method === 'sendMessage') {
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 51 } }) };
      }
      if (method === 'getUpdates') {
        return { ok: true, json: async () => ({ ok: true, result: [{
          update_id: 1,
          callback_query: {
            id: 'callback-1',
            data: 'owner:fixednonce:a',
            message: { chat: { id: 12345 } },
          },
        }] }) };
      }
      clock = 180000;
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    },
  });

  assert.deepEqual(
    await selector.chooseOwner({
      ticketNumber: 1,
      candidates: [{ key: 'a', name: 'בעלים א' }],
    }),
    { status: 'timeout' }
  );
});
