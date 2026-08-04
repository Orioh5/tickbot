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

test('creates opaque keys while retaining identifiers only in memory', () => {
  assert.deepEqual(parseOwnerCandidates([
    { text: 'בעלים א (000000001)', identifier: '000000001' },
    { text: 'בעלים ב (000000002)', identifier: '000000002' },
  ]), [
    { key: '0', name: 'בעלים א', identifier: '000000001' },
    { key: '1', name: 'בעלים ב', identifier: '000000002' },
  ]);
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
  return {
    waitForResponse: async predicate => {
      const response = {
        url: () => 'https://tickets.mhaifafc.com/Transaction2/ChangeIdentifier',
        request: () => ({ method: () => 'POST' }),
        ok: () => responseOk,
      };
      assert.equal(predicate(response), true);
      return response;
    },
    evaluate: async (_fn, { identifier }) => identifier === '000000001',
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
  return {
    page: {
      waitForResponse: async predicate => {
        assert.equal(predicate(response), true);
        return response;
      },
      evaluate: async (fn, argument) => fn(argument),
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
