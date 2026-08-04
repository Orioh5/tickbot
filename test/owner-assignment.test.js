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

test('removes a comma-separated trailing identity number from an owner display label', () => {
  assert.equal(redactOwnerName('בעלים א (000,000,001)'), 'בעלים א');
});

test('removes a colon-separated trailing identity number from an owner display label', () => {
  assert.equal(redactOwnerName('בעלים א (000:000:001)'), 'בעלים א');
});

test('removes an Arabic thousands-separated identity number from an owner display label', () => {
  assert.equal(redactOwnerName('בעלים א (٠٠٠٬٠٠٠٬٠٠١)'), 'בעלים א');
});

test('keeps an ordinary short-number owner label', () => {
  assert.equal(redactOwnerName('בעלים א 123'), 'בעלים א 123');
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

test('omits candidates with embedded punctuation-form identity-like decimal sequences', () => {
  assert.deepEqual(parseOwnerCandidates([
    { text: 'בעלים א 000,000,001 נוסף', identifier: '000000001' },
  ]), []);
});

function makeOwnerPageFake({ assignmentRequired, owners = [] }) {
  let opened = false;
  let evaluations = 0;
  const dropdown = {
    querySelectorAll: selector => {
      assert.equal(selector, '.fnAssignDropdownItem');
      return owners.map(owner => ({
        textContent: owner.text,
        dataset: { useridentifier: owner.identifier },
      }));
    },
  };
  const ticket = {
    querySelector: selector => {
      assert.equal(selector, '.fnIdentifier');
      return { value: '', classList: { contains: () => false } };
    },
  };
  const button = {
    nextElementSibling: dropdown,
    closest: selector => {
      assert.equal(selector, '.transaction-ticket');
      return ticket;
    },
  };
  return {
    locator: selector => {
      assert.equal(selector, '.transaction-ticket .fnAssignButton:visible');
      return {
        count: async () => assignmentRequired ? 1 : 0,
        first: () => ({
          click: async () => { opened = true; },
          evaluate: async (fn, argument) => {
            if (evaluations++ > 0) assert.equal(opened, true);
            return fn(button, argument);
          },
        }),
      };
    },
    evaluate: async () => assert.fail('discovery must stay bound to the clicked locator'),
  };
}

function makeLocatorBoundDiscoveryPageFake() {
  const makeTicket = (owners, visible) => {
    const dropdown = {
      querySelectorAll: selector => {
        assert.equal(selector, '.fnAssignDropdownItem');
        return owners.map(owner => ({
          textContent: owner.text,
          dataset: { useridentifier: owner.identifier },
        }));
      },
    };
    const ticket = {
      querySelector: selector => {
        assert.equal(selector, '.fnIdentifier');
        return { value: '', classList: { contains: () => false } };
      },
    };
    const button = {
      visible,
      nextElementSibling: dropdown,
      closest: selector => {
        assert.equal(selector, '.transaction-ticket');
        return ticket;
      },
    };
    return { ticket, button };
  };

  const hidden = makeTicket([
    { text: 'בעלים מוסתר (000000009)', identifier: '000000009' },
  ], false);
  const visible = makeTicket([
    { text: 'בעלים נראה (000000001)', identifier: '000000001' },
  ], true);
  const tickets = [hidden, visible];
  let clickedButton = null;
  let evaluations = 0;

  return {
    document: {
      querySelector: selector => {
        assert.equal(selector, '.transaction-ticket .fnAssignButton:not(.hide)');
        return hidden.button;
      },
      querySelectorAll: selector => {
        assert.equal(selector, '.transaction-ticket');
        return tickets.map(item => item.ticket);
      },
    },
    page: {
      locator: selector => {
        assert.equal(selector, '.transaction-ticket .fnAssignButton:visible');
        return {
          count: async () => 1,
          first: () => ({
            click: async () => { clickedButton = visible.button; },
            evaluate: async (fn, argument) => {
              if (evaluations++ > 0) assert.equal(clickedButton, visible.button);
              return fn(visible.button, argument);
            },
          }),
        };
      },
      evaluate: async fn => fn(),
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

test('binds owner discovery and application to the exact visible assignment button clicked', async () => {
  const discoveryPage = makeLocatorBoundDiscoveryPageFake();
  const previousDocument = global.document;
  global.document = discoveryPage.document;
  let candidate;
  try {
    const result = await discoverOwnerCandidates(discoveryPage.page);
    candidate = result.candidates[0];
    assert.equal(candidate.key, '0');
    assert.equal(candidate.name, 'בעלים נראה');
    assert.equal(candidate.identifier, '000000001');
    assert.equal(typeof candidate.ticketKey, 'string');
    assert.equal('ticketIndex' in candidate, false);
  } finally {
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
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
    await applyOwnerCandidate(page, {
      key: '0', name: 'בעלים א', identifier: '000000001', ticketKey: 'ticket-a',
    }),
    { status: 'assigned' }
  );
});

test('reports rejected when the site keeps the identifier invalid', async () => {
  const page = makeAssignmentPageFake({ responseOk: true, accepted: false });
  assert.deepEqual(
    await applyOwnerCandidate(page, {
      key: '0', name: 'בעלים א', identifier: '000000001', ticketKey: 'ticket-a',
    }),
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
    applyOwnerCandidate(page, {
      key: '0', name: 'בעלים א', identifier: '000000001', ticketKey: 'ticket-a',
    }),
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
        key: '0', name: 'בעלים א', identifier: '000000001', ticketKey: 'ticket-a',
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
        key: '0', name: 'בעלים א', identifier: '000000001', ticketKey: 'ticket-a',
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
  tickets[1].ticket.__mhfcOwnerFlowTicketKey = 'ticket-b';
  const previousDocument = global.document;
  global.document = document;
  try {
    assert.deepEqual(
      await applyOwnerCandidate(page, {
        key: '0',
        name: 'בעלים א',
        identifier: '000000001',
        ticketKey: 'ticket-b',
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

function makeStatefulOwnerCart(ticketDefinitions) {
  const listeners = new Set();
  let tickets = ticketDefinitions.map((definition, index) => {
    const ticket = {
      label: definition.label,
      selected: false,
      opened: false,
    };
    const input = {
      value: definition.assigned ? definition.identifier : '',
      classList: { contains: className => className === 'invalid' ? !definition.accepted : false },
    };
    const target = {
      textContent: definition.text,
      dataset: { useridentifier: definition.identifier },
      click: () => {
        ticket.selected = true;
        input.value = definition.identifier;
      },
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
      closest: selector => {
        assert.equal(selector, '.transaction-ticket');
        return ticket;
      },
      click: () => { ticket.opened = true; },
    };
    ticket.querySelector = selector => {
      if (selector === '.fnAssignButton:not(.hide)') return button;
      if (selector === '.fnIdentifier') return input;
      throw new Error(`Unexpected ticket selector: ${selector}`);
    };
    return { index, ticket, button, input, target };
  });

  const document = {
    querySelectorAll: selector => {
      if (selector === '.transaction-ticket') return tickets.map(item => item.ticket);
      throw new Error(`Unexpected document selector: ${selector}`);
    },
  };
  const response = {
    url: () => 'https://tickets.mhaifafc.com/Transaction2/ChangeIdentifier',
    request: () => ({ method: () => 'POST' }),
    ok: () => true,
    status: () => 200,
  };

  const locatorFor = item => ({
    click: async () => { item.button.click(); },
    evaluate: async (fn, argument) => fn(item.button, argument),
  });
  const page = {
    locator: selector => {
      assert.equal(selector, '.transaction-ticket .fnAssignButton:visible');
      return {
        count: async () => tickets.length,
        first: () => locatorFor(tickets[0]),
        nth: index => locatorFor(tickets[index]),
      };
    },
    on: (event, listener) => {
      assert.equal(event, 'response');
      listeners.add(listener);
    },
    off: (event, listener) => {
      assert.equal(event, 'response');
      listeners.delete(listener);
    },
    evaluate: async (fn, argument) => {
      const selectedBefore = tickets.some(item => item.ticket.selected);
      const result = fn(argument);
      const selectedAfter = tickets.some(item => item.ticket.selected);
      if (!selectedBefore && selectedAfter) {
        for (const listener of listeners) listener(response);
      }
      return result;
    },
    waitForFunction: async (fn, argument) => {
      if (!fn(argument)) {
        const error = new Error('timeout');
        error.name = 'TimeoutError';
        throw error;
      }
    },
  };

  return {
    page,
    document,
    tickets: () => tickets,
    reorder: order => { tickets = order.map(index => tickets[index]); },
    replace: index => {
      const old = tickets[index];
      const replacement = makeStatefulOwnerCart([{
        label: `${old.ticket.label}-replacement`,
        text: old.target.textContent,
        identifier: old.target.dataset.useridentifier,
        accepted: true,
      }]).tickets()[0];
      tickets[index] = replacement;
      return replacement;
    },
  };
}

async function withStatefulOwnerCart(cart, operation) {
  const previousDocument = global.document;
  global.document = cart.document;
  try {
    return await operation();
  } finally {
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
}

test('skips a verified assigned ticket even when its assignment button stays visible', async () => {
  const cart = makeStatefulOwnerCart([
    { label: 'first', text: 'בעלים א', identifier: 'owner-ref', accepted: true },
    { label: 'second', text: 'בעלים ב', identifier: 'owner-ref', accepted: true },
  ]);

  await withStatefulOwnerCart(cart, async () => {
    const first = await discoverOwnerCandidates(cart.page);
    assert.equal(first.required, true);
    assert.equal(typeof first.candidates[0].ticketKey, 'string');
    assert.equal('ticketIndex' in first.candidates[0], false);
    assert.deepEqual(await applyOwnerCandidate(cart.page, first.candidates[0]), { status: 'assigned' });

    const second = await discoverOwnerCandidates(cart.page);
    assert.equal(second.required, true);
    assert.equal(second.candidates[0].name, 'בעלים ב');
    assert.notEqual(second.candidates[0].ticketKey, first.candidates[0].ticketKey);
  });
});

test('applies a selection to the same keyed ticket after the DOM order changes', async () => {
  const cart = makeStatefulOwnerCart([
    { label: 'first', text: 'בעלים א', identifier: 'owner-ref', accepted: true },
    { label: 'second', text: 'בעלים א', identifier: 'owner-ref', accepted: true },
  ]);

  await withStatefulOwnerCart(cart, async () => {
    const discovery = await discoverOwnerCandidates(cart.page);
    const originalTicket = cart.tickets()[0].ticket;
    const otherTicket = cart.tickets()[1].ticket;
    cart.reorder([1, 0]);

    assert.deepEqual(
      await applyOwnerCandidate(cart.page, discovery.candidates[0]),
      { status: 'assigned' }
    );
    assert.equal(originalTicket.selected, true);
    assert.equal(otherTicket.selected, false);
  });
});

test('fails closed when the keyed ticket is replaced before the callback is applied', async () => {
  const cart = makeStatefulOwnerCart([
    { label: 'first', text: 'בעלים א', identifier: 'owner-ref', accepted: true },
  ]);

  await withStatefulOwnerCart(cart, async () => {
    const discovery = await discoverOwnerCandidates(cart.page);
    const originalTicket = cart.tickets()[0].ticket;
    const replacement = cart.replace(0);

    await assert.rejects(
      applyOwnerCandidate(cart.page, discovery.candidates[0]),
      /no longer available|ticket/i
    );
    assert.equal(originalTicket.selected, false);
    assert.equal(replacement.ticket.selected, false);
  });
});
