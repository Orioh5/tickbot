const test = require('node:test');
const assert = require('node:assert/strict');
const {
  redactOwnerName,
  parseOwnerCandidates,
  discoverOwnerCandidates,
  applyOwnerCandidate,
} = require('../owner-assignment');

test('removes a trailing identity number from an owner display label', () => {
  assert.equal(redactOwnerName('בעלים א (000000001)'), 'בעלים א');
});

test('removes an unparenthesized trailing identity number from an owner display label', () => {
  assert.equal(redactOwnerName('בעלים א 000000003'), 'בעלים א');
});

test('removes an ID-prefixed identity number from an owner display label', () => {
  assert.equal(redactOwnerName('בעלים א (ID: 000000004)'), 'בעלים א');
});

test('removes a hyphenated trailing identity number from an owner display label', () => {
  assert.equal(redactOwnerName('בעלים א (000-000-001)'), 'בעלים א');
});

test('removes an ID-prefixed hyphenated identity number from an owner display label', () => {
  assert.equal(redactOwnerName('בעלים א (ID: 000-000-001)'), 'בעלים א');
});

test('removes an Arabic-decimal identity number from an owner display label', () => {
  assert.equal(redactOwnerName('בעלים א (٠٠٠-٠٠٠-٠٠١)'), 'בעלים א');
});

test('creates opaque keys while retaining identifiers only in memory', () => {
  assert.deepEqual(parseOwnerCandidates([
    { text: 'בעלים א (000000001)', identifier: '000000001' },
    { text: 'בעלים ב (000000002)', identifier: '000000002' },
  ]), [
    { key: '0', name: 'בעלים א', identifier: '000000001' },
    { key: '1', name: 'בעלים ב', identifier: '000000002' },
  ]);
});

test('omits candidates whose labels retain an identity-like decimal sequence', () => {
  assert.deepEqual(parseOwnerCandidates([
    { text: 'בעלים א מזהה 000-000-001 נוסף', identifier: '000000001' },
  ]), []);
});

function makeOwnerPageFake({ assignmentRequired, owners = [] }) {
  let opened = false;
  return {
    locator: selector => {
      assert.equal(selector, '.transaction-ticket .fnAssignButton:visible');
      return {
        count: async () => assignmentRequired ? 1 : 0,
        first: () => ({ click: async () => { opened = true; } }),
      };
    },
    evaluate: async () => {
      assert.equal(opened, true);
      return { ticketIndex: 0, items: owners };
    },
  };
}

test('returns required false when no assignment button exists', async () => {
  const page = makeOwnerPageFake({ assignmentRequired: false });
  assert.deepEqual(await discoverOwnerCandidates(page), { required: false });
});

test('discovers every owner from the active assignment dropdown', async () => {
  const page = makeOwnerPageFake({
    assignmentRequired: true,
    owners: [
      { text: 'בעלים א (000000001)', identifier: '000000001' },
      { text: 'בעלים ב (000000002)', identifier: '000000002' },
    ],
  });
  const result = await discoverOwnerCandidates(page);
  assert.equal(result.required, true);
  assert.deepEqual(result.candidates.map(x => ({ key: x.key, name: x.name })), [
    { key: '0', name: 'בעלים א' },
    { key: '1', name: 'בעלים ב' },
  ]);
});

function makeAssignmentPageFake({ responseOk, accepted }) {
  const listeners = new Set();
  let evaluations = 0;
  const response = {
    url: () => 'https://tickets.mhaifafc.com/Transaction2/ChangeIdentifier',
    request: () => ({ method: () => 'POST' }),
    ok: () => responseOk,
  };
  return {
    on: (event, listener) => {
      assert.equal(event, 'response');
      listeners.add(listener);
    },
    off: (event, listener) => {
      assert.equal(event, 'response');
      listeners.delete(listener);
    },
    evaluate: async (_fn, { identifier }) => {
      const result = identifier === '000000001';
      if (++evaluations === 2) {
        for (const listener of listeners) listener(response);
      }
      return result;
    },
    waitForFunction: async () => {
      if (!accepted) {
        const error = new Error('timeout');
        error.name = 'TimeoutError';
        throw error;
      }
    },
  };
}

test('reports assigned only after ChangeIdentifier and accepted DOM state', async () => {
  const page = makeAssignmentPageFake({ responseOk: true, accepted: true });
  assert.deepEqual(
    await applyOwnerCandidate(page, { key: '0', name: 'בעלים א', identifier: '000000001' }),
    { status: 'assigned' }
  );
});

test('reports rejected when the site keeps the identifier invalid', async () => {
  const page = makeAssignmentPageFake({ responseOk: true, accepted: false });
  assert.deepEqual(
    await applyOwnerCandidate(page, { key: '0', name: 'בעלים א', identifier: '000000001' }),
    { status: 'rejected', reason: 'The ticketing site rejected this owner' }
  );
});

test('does not register a response wait when the selected owner is no longer available', async () => {
  let responseWaits = 0;
  const page = {
    waitForResponse: () => {
      responseWaits++;
      return new Promise(() => {});
    },
    evaluate: async () => false,
  };

  await assert.rejects(
    applyOwnerCandidate(page, { key: '0', name: 'בעלים א', identifier: '000000001', ticketIndex: 0 }),
    /Selected owner is no longer available/
  );
  assert.equal(responseWaits, 0);
});

test('cleans response observation when the owner disappears after preflight', async () => {
  const listeners = new Set();
  const timers = new Set();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  global.setTimeout = (callback, timeout) => {
    const timer = { callback, timeout };
    timers.add(timer);
    return timer;
  };
  global.clearTimeout = timer => { timers.delete(timer); };
  let evaluations = 0;
  const page = {
    on: (event, listener) => {
      assert.equal(event, 'response');
      listeners.add(listener);
    },
    off: (event, listener) => {
      assert.equal(event, 'response');
      listeners.delete(listener);
    },
    waitForResponse: () => {
      const listener = () => {};
      listeners.add(listener);
      global.setTimeout(() => {}, 5000);
      return new Promise(() => {});
    },
    evaluate: async () => ++evaluations === 1,
  };

  try {
    await assert.rejects(
      applyOwnerCandidate(page, {
        key: '0', name: 'בעלים א', identifier: '000000001', ticketIndex: 0,
      }),
      /Selected owner is no longer available/
    );
    assert.equal(listeners.size, 0);
    assert.equal(timers.size, 0);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('cleans response observation when the click evaluation fails', async () => {
  const listeners = new Set();
  const timers = new Set();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  global.setTimeout = (callback, timeout) => {
    const timer = { callback, timeout };
    timers.add(timer);
    return timer;
  };
  global.clearTimeout = timer => { timers.delete(timer); };
  let evaluations = 0;
  const page = {
    on: (_event, listener) => { listeners.add(listener); },
    off: (_event, listener) => { listeners.delete(listener); },
    evaluate: async () => {
      if (++evaluations === 1) return true;
      throw new Error('click evaluation failed');
    },
  };

  try {
    await assert.rejects(
      applyOwnerCandidate(page, {
        key: '0', name: 'בעלים א', identifier: '000000001', ticketIndex: 0,
      }),
      /click evaluation failed/
    );
    assert.equal(listeners.size, 0);
    assert.equal(timers.size, 0);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

function makeTwoTicketPageFake() {
  const tickets = [0, 1].map((index) => {
    const input = {
      value: '000000001',
      classList: { contains: className => index === 1 && className === 'invalid' },
    };
    const target = {
      dataset: { useridentifier: '000000001' },
      click: () => { ticket.selected = true; },
    };
    const dropdown = {
      querySelectorAll: selector => {
        assert.equal(selector, '.fnAssignDropdownItem');
        return [target];
      },
    };
    const button = {
      classList: { contains: () => false },
      nextElementSibling: dropdown,
      click: () => { ticket.opened = true; },
    };
    const ticket = {
      opened: false,
      selected: false,
      querySelector: selector => {
        if (selector === '.fnAssignButton:not(.hide)') return button;
        if (selector === '.fnIdentifier') return input;
        throw new Error(`Unexpected ticket selector: ${selector}`);
      },
    };
    return { ticket, button, input };
  });

  const document = {
    querySelectorAll: selector => {
      if (selector === '.transaction-ticket') return tickets.map(item => item.ticket);
      if (selector === '.transaction-ticket .fnAssignButton') return tickets.map(item => item.button);
      if (selector === '.transaction-ticket .fnIdentifier') return tickets.map(item => item.input);
      throw new Error(`Unexpected document selector: ${selector}`);
    },
    querySelector: selector => {
      assert.equal(selector, '.transaction-ticket .fnIdentifier');
      return tickets[0].input;
    },
  };
  const response = {
    url: () => 'https://tickets.mhaifafc.com/Transaction2/ChangeIdentifier',
    request: () => ({ method: () => 'POST' }),
    ok: () => true,
  };
  const listeners = new Set();
  let evaluations = 0;
  return {
    page: {
      on: (event, listener) => {
        assert.equal(event, 'response');
        listeners.add(listener);
      },
      off: (event, listener) => {
        assert.equal(event, 'response');
        listeners.delete(listener);
      },
      evaluate: async (fn, argument) => {
        const result = fn(argument);
        if (++evaluations === 2) {
          for (const listener of listeners) listener(response);
        }
        return result;
      },
      waitForFunction: async (predicate, argument) => {
        if (!predicate(argument)) {
          const error = new Error('timeout');
          error.name = 'TimeoutError';
          throw error;
        }
      },
    },
    document,
    tickets,
  };
}

test('verifies the owner assignment in the selected transaction ticket', async () => {
  const { page, document, tickets } = makeTwoTicketPageFake();
  const previousDocument = global.document;
  global.document = document;
  try {
    assert.deepEqual(
      await applyOwnerCandidate(page, {
        key: '0',
        name: 'בעלים א',
        identifier: '000000001',
        ticketIndex: 1,
      }),
      { status: 'rejected', reason: 'The ticketing site rejected this owner' }
    );
    assert.equal(tickets[0].ticket.selected, false);
    assert.equal(tickets[1].ticket.selected, true);
  } finally {
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
});
