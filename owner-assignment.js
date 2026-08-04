const crypto = require('crypto');

const IDENTITY_SEQUENCE = /\p{Nd}(?:[^\p{L}\p{N}]*\p{Nd}){4,}/u;
const TRAILING_IDENTITY_SUFFIX = new RegExp(
  `\\s*(?:\\(\\s*)?(?:id\\s*:\\s*)?${IDENTITY_SEQUENCE.source}(?:\\s*\\))?\\s*$`,
  'iu'
);
const RESPONSE_TIMEOUT_MS = 5000;
const TICKET_KEY_PROPERTY = '__mhfcOwnerFlowTicketKey';
const assignedTicketKeysByPage = new WeakMap();

function assignedTicketKeys(page) {
  let assigned = assignedTicketKeysByPage.get(page);
  if (!assigned) {
    assigned = new Set();
    assignedTicketKeysByPage.set(page, assigned);
  }
  return assigned;
}

function createTicketKey() {
  return crypto.randomBytes(12).toString('hex');
}

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
  const count = await buttons.count();
  const assigned = assignedTicketKeys(page);

  for (let index = 0; index < count; index++) {
    const button = typeof buttons.nth === 'function' ? buttons.nth(index) : buttons.first();
    const proposedTicketKey = createTicketKey();
    const state = await button.evaluate((activeButton, { keyProperty, proposedKey }) => {
      const ticket = activeButton?.closest('.transaction-ticket');
      if (!ticket) return null;
      if (!Object.prototype.hasOwnProperty.call(ticket, keyProperty)) {
        Object.defineProperty(ticket, keyProperty, {
          value: proposedKey,
          configurable: true,
          enumerable: false,
        });
      }
      const identifierInput = ticket.querySelector('.fnIdentifier');
      return {
        ticketKey: ticket[keyProperty],
        assigned: Boolean(
          identifierInput?.value && !identifierInput.classList.contains('invalid')
        ),
      };
    }, { keyProperty: TICKET_KEY_PROPERTY, proposedKey: proposedTicketKey });

    if (!state) continue;
    if (state.assigned || assigned.has(state.ticketKey)) {
      assigned.add(state.ticketKey);
      continue;
    }

    await button.click();
    const discovered = await button.evaluate((activeButton, { keyProperty, ticketKey }) => {
      const ticket = activeButton?.closest('.transaction-ticket');
      if (!ticket || ticket[keyProperty] !== ticketKey) return null;
      const dropdown = activeButton.nextElementSibling;
      return Array.from(dropdown?.querySelectorAll('.fnAssignDropdownItem') || []).map(item => ({
        text: (item.textContent || '').trim(),
        identifier: item.dataset.useridentifier || '',
      }));
    }, { keyProperty: TICKET_KEY_PROPERTY, ticketKey: state.ticketKey });
    if (!discovered) throw new Error('Owner ticket changed during discovery');

    const candidates = parseOwnerCandidates(discovered);
    if (candidates.length === 0) {
      throw new Error('Owner assignment is required but no candidates were found');
    }
    return {
      required: true,
      candidates: candidates.map(candidate => ({
        ...candidate,
        ticketKey: state.ticketKey,
      })),
    };
  }

  return { required: false };
}

async function applyOwnerCandidate(page, candidate) {
  if (!candidate.ticketKey) throw new Error('Selected owner is no longer available');
  const assignment = {
    identifier: candidate.identifier,
    ticketKey: candidate.ticketKey,
    keyProperty: TICKET_KEY_PROPERTY,
  };
  const available = await page.evaluate(({ identifier, ticketKey, keyProperty }) => {
    const ticket = Array.from(document.querySelectorAll('.transaction-ticket'))
      .find(item => item[keyProperty] === ticketKey);
    const button = ticket?.querySelector('.fnAssignButton:not(.hide)');
    const dropdown = button?.nextElementSibling;
    return Boolean(Array.from(dropdown?.querySelectorAll('.fnAssignDropdownItem') || [])
      .find(item => item.dataset.useridentifier === identifier));
  }, assignment);
  if (!available) throw new Error('Selected owner is no longer available');

  const responseObserver = observeChangeIdentifierResponse(page);
  let clicked;
  try {
    clicked = await page.evaluate(({ identifier, ticketKey, keyProperty }) => {
      const ticket = Array.from(document.querySelectorAll('.transaction-ticket'))
        .find(item => item[keyProperty] === ticketKey);
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
    await page.waitForFunction(({ identifier, ticketKey, keyProperty }) => {
      const ticket = Array.from(document.querySelectorAll('.transaction-ticket'))
        .find(item => item[keyProperty] === ticketKey);
      const input = ticket?.querySelector('.fnIdentifier');
      return input?.value === identifier && !input.classList.contains('invalid');
    }, assignment, { timeout: 5000 });
    assignedTicketKeys(page).add(candidate.ticketKey);
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
