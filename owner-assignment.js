function redactOwnerName(displayText) {
  const redacted = String(displayText || '')
    .replace(/\s*\(\s*(?:id\s*:\s*)?\d{5,}\s*\)\s*$/i, '')
    .replace(/\s+(?:id\s*:\s*)?\d{5,}\s*$/i, '')
    .trim();
  return /\d{5,}/.test(redacted) ? '' : redacted;
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

  const responsePromise = page.waitForResponse(response =>
    response.url().includes('/Transaction2/ChangeIdentifier') &&
    response.request().method() === 'POST'
  );
  const clicked = await page.evaluate(({ identifier, ticketIndex: index }) => {
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
  if (!clicked) {
    responsePromise.catch(() => {});
    throw new Error('Selected owner is no longer available');
  }

  const response = await responsePromise;
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
