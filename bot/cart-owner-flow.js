'use strict';

const crypto = require('crypto');
const { discoverOwnerCandidates, applyOwnerCandidate } = require('../owner-assignment');

// Drives the owner assignment loop for all unassigned tickets on a page,
// prompting the user via Telegram for each ticket and applying the selection.
// Used for standalone cart recovery outside of the Monitor's normal loop.
class CartOwnerFlow {
  constructor({ telegramBotService, ownerBrowser = { discover: discoverOwnerCandidates, apply: applyOwnerCandidate } }) {
    this.bot = telegramBotService;
    this.ownerBrowser = ownerBrowser;
  }

  async run(userId, chatId, page, ticketNumber = 1) {
    const assignment = await this.ownerBrowser.discover(page);
    if (!assignment.required) return { status: 'not_required' };

    const { candidates } = assignment;
    // Unique nonce per invocation so concurrent tickets don't collide
    const nonce = crypto.randomBytes(6).toString('hex');
    const keyboard = candidates.map(c => [{ text: c.name, callback_data: `${nonce}:${c.key}` }]);

    // Register before sending so no callback can arrive before we're listening
    const selectedKey = await new Promise((resolve) => {
      this.bot.registerCallbackHandler(nonce, userId, resolve, 180_000);
      this.bot.sendMessage(chatId, `בחר בעלים לכרטיס ${ticketNumber}:`, {
        reply_markup: { inline_keyboard: keyboard },
      }).catch(() => {});
    });

    if (selectedKey == null) return { status: 'timeout' };

    const candidate = candidates.find(c => c.key === selectedKey);
    if (!candidate) return { status: 'error', message: 'Unknown candidate selected' };

    return this.ownerBrowser.apply(page, candidate);
  }
}

module.exports = CartOwnerFlow;
