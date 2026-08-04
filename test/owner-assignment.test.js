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
      return owners;
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
    evaluate: async (_fn, identifier) => identifier === '000000001',
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
