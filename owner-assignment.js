function redactOwnerName(displayText) {
  return String(displayText || '').replace(/\s*\(\d{5,}\)\s*$/, '').trim();
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
  const items = await page.evaluate(() => {
    const activeButton = document.querySelector('.transaction-ticket .fnAssignButton:not(.hide)');
    const dropdown = activeButton?.nextElementSibling;
    return Array.from(dropdown?.querySelectorAll('.fnAssignDropdownItem') || []).map(item => ({
      text: (item.textContent || '').trim(),
      identifier: item.dataset.useridentifier || '',
    }));
  });
  const candidates = parseOwnerCandidates(items);
  if (candidates.length === 0) {
    throw new Error('Owner assignment is required but no candidates were found');
  }
  return { required: true, candidates };
}

async function applyOwnerCandidate(page, candidate) {
  const responsePromise = page.waitForResponse(response =>
    response.url().includes('/Transaction2/ChangeIdentifier') &&
    response.request().method() === 'POST'
  );
  const clicked = await page.evaluate(identifier => {
    const buttons = Array.from(document.querySelectorAll('.transaction-ticket .fnAssignButton'));
    const button = buttons.find(item => !item.classList.contains('hide'));
    if (!button) return false;
    button.click();
    const dropdown = button.nextElementSibling;
    const target = Array.from(dropdown?.querySelectorAll('.fnAssignDropdownItem') || [])
      .find(item => item.dataset.useridentifier === identifier);
    if (!target) return false;
    target.click();
    return true;
  }, candidate.identifier);
  if (!clicked) throw new Error('Selected owner is no longer available');

  const response = await responsePromise;
  if (!response.ok()) throw new Error(`ChangeIdentifier returned HTTP ${response.status()}`);
  try {
    await page.waitForFunction(identifier => {
      const input = document.querySelector('.transaction-ticket .fnIdentifier');
      return input?.value === identifier && !input.classList.contains('invalid');
    }, candidate.identifier, { timeout: 5000 });
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
