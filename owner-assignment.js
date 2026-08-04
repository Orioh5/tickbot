const IDENTITY_SEQUENCE = /\p{Nd}(?:[\s\p{Pd}._/]*\p{Nd}){4,}/u;
const TRAILING_IDENTITY_SUFFIX = new RegExp(
  `\\s*(?:\\(\\s*)?(?:id\\s*:\\s*)?${IDENTITY_SEQUENCE.source}(?:\\s*\\))?\\s*$`,
  'iu'
);
const RESPONSE_TIMEOUT_MS = 5000;

function redactOwnerName(displayText) {
  const redacted = String(displayText || '')
    .replace(TRAILING_IDENTITY_SUFFIX, '')
    .trim();
  return IDENTITY_SEQUENCE.test(redacted) ? '' : redacted;
}

function observeChangeIdentifierResponse(page) {
  let listener;
  let timeoutId;
  let settled = false;
  let resolvePromise;
  let rejectPromise;

  const cleanup = () => {
    clearTimeout(timeoutId);
    page.off('response', listener);
  };
  const settle = (response, error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectPromise(error);
    else resolvePromise(response);
  };
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  listener = response => {
    try {
      if (
        response.url().includes('/Transaction2/ChangeIdentifier') &&
        response.request().method() === 'POST'
      ) {
        settle(response);
      }
    } catch (error) {
      settle(null, error);
    }
  };
  page.on('response', listener);
  if (!settled) {
    timeoutId = setTimeout(() => {
      settle(null, new Error('Timed out waiting for ChangeIdentifier'));
    }, RESPONSE_TIMEOUT_MS);
  }

  return {
    promise,
    cancel: () => settle(),
  };
}

function parseOwnerCandidates(items) {
  return items
    .filter(item => item.identifier && redactOwnerName(item.text))
    .map((item, index) => ({
      key: String(index),
      name: redactOwnerName(item.text),
      identifier: String(item.identifier),
    }));
}

async function discoverOwnerCandidates(page) {
  const buttons = page.locator('.transaction-ticket .fnAssignButton:visible');
  if (await buttons.count() === 0) return { required: false };
  const button = buttons.first();
  await button.click();
  const discovered = await page.evaluate(() => {
    const activeButton = document.querySelector('.transaction-ticket .fnAssignButton:not(.hide)');
    const dropdown = activeButton?.nextElementSibling;
    const ticket = activeButton?.closest('.transaction-ticket');
    return {
      ticketIndex: Array.from(document.querySelectorAll('.transaction-ticket')).indexOf(ticket),
      items: Array.from(dropdown?.querySelectorAll('.fnAssignDropdownItem') || []).map(item => ({
        text: (item.textContent || '').trim(),
        identifier: item.dataset.useridentifier || '',
      })),
    };
  });
  const { ticketIndex, items } = discovered;
  const candidates = parseOwnerCandidates(items);
  if (candidates.length === 0) {
    throw new Error('Owner assignment is required but no candidates were found');
  }
  return {
    required: true,
    candidates: candidates.map(candidate => ({ ...candidate, ticketIndex })),
  };
}

async function applyOwnerCandidate(page, candidate) {
  const ticketIndex = Number.isInteger(candidate.ticketIndex) ? candidate.ticketIndex : 0;
  const assignment = { identifier: candidate.identifier, ticketIndex };
  const available = await page.evaluate(({ identifier, ticketIndex: index }) => {
    const ticket = Array.from(document.querySelectorAll('.transaction-ticket'))[index];
    const button = ticket?.querySelector('.fnAssignButton:not(.hide)');
    const dropdown = button?.nextElementSibling;
    return Boolean(Array.from(dropdown?.querySelectorAll('.fnAssignDropdownItem') || [])
      .find(item => item.dataset.useridentifier === identifier));
  }, assignment);
  if (!available) throw new Error('Selected owner is no longer available');

  const responseObserver = observeChangeIdentifierResponse(page);
  let clicked;
  try {
    clicked = await page.evaluate(({ identifier, ticketIndex: index }) => {
      const ticket = Array.from(document.querySelectorAll('.transaction-ticket'))[index];
      const button = ticket?.querySelector('.fnAssignButton:not(.hide)');
      if (!button) return false;
      button.click();
      const dropdown = button.nextElementSibling;
      const target = Array.from(dropdown?.querySelectorAll('.fnAssignDropdownItem') || [])
        .find(item => item.dataset.useridentifier === identifier);
      if (!target) return false;
      target.click();
      return true;
    }, assignment);
  } catch (error) {
    responseObserver.cancel();
    throw error;
  }
  if (!clicked) {
    responseObserver.cancel();
    throw new Error('Selected owner is no longer available');
  }

  const response = await responseObserver.promise;
  if (!response.ok()) throw new Error(`ChangeIdentifier returned HTTP ${response.status()}`);
  try {
    await page.waitForFunction(({ identifier, ticketIndex: index }) => {
      const ticket = Array.from(document.querySelectorAll('.transaction-ticket'))[index];
      const input = ticket?.querySelector('.fnIdentifier');
      return input?.value === identifier && !input.classList.contains('invalid');
    }, assignment, { timeout: 5000 });
    return { status: 'assigned' };
  } catch (error) {
    if (error.name === 'TimeoutError') {
      return { status: 'rejected', reason: 'The ticketing site rejected this owner' };
    }
    throw error;
  }
}

module.exports = {
  redactOwnerName,
  parseOwnerCandidates,
  discoverOwnerCandidates,
  applyOwnerCandidate,
};
