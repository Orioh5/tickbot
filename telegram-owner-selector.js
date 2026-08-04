const crypto = require('crypto');

class TelegramOwnerSelector {
  constructor({
    token,
    chatId,
    fetchImpl = fetch,
    nonceFactory = () => crypto.randomBytes(8).toString('hex'),
    now = () => Date.now(),
    timeoutMs = 180000,
  }) {
    this.token = token;
    this.chatId = String(chatId);
    this.fetchImpl = fetchImpl;
    this.nonceFactory = nonceFactory;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.updateOffset = 0;
  }

  async _call(method, body, options = {}) {
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal,
      }
    );
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(`Telegram ${method} failed`);
    }
    return payload.result;
  }

  async chooseOwner(request) {
    try {
      return await this._chooseOwner(request);
    } catch (error) {
      if (request.signal?.aborted || error.name === 'AbortError') {
        return { status: 'cancelled' };
      }
      return { status: 'error', message: error.message };
    }
  }

  async _chooseOwner({ ticketNumber, candidates, signal }) {
    const nonce = this.nonceFactory();
    const allowed = new Set(candidates.map(candidate => candidate.key));
    await this._call('sendMessage', {
      chat_id: this.chatId,
      text: `בחר בעלים לכרטיס ${ticketNumber}`,
      reply_markup: {
        inline_keyboard: candidates.map(candidate => [{
          text: candidate.name,
          callback_data: `owner:${nonce}:${candidate.key}`,
        }]),
      },
    });
    if (signal?.aborted) return { status: 'cancelled' };

    const deadline = this.now() + this.timeoutMs;
    while (this.now() < deadline) {
      if (signal?.aborted) return { status: 'cancelled' };
      const updates = await this._call('getUpdates', {
        offset: this.updateOffset,
        timeout: 20,
        allowed_updates: ['callback_query'],
      }, { signal });
      for (const update of updates) {
        this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
        const query = update.callback_query;
        if (!query) continue;
        const [prefix, callbackNonce, candidateKey] = String(query.data || '').split(':');
        if (
          prefix !== 'owner' || callbackNonce !== nonce ||
          String(query.message?.chat?.id) !== this.chatId || !allowed.has(candidateKey)
        ) continue;
        await this._call('answerCallbackQuery', { callback_query_id: query.id });
        return { status: 'selected', candidateKey };
      }
    }
    return { status: 'timeout' };
  }
}

module.exports = TelegramOwnerSelector;
