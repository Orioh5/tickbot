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
    if (options.signal?.aborted) throw TelegramOwnerSelector._abortError();
    const operation = (async () => {
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
    })();

    if (!options.signal) return operation;

    let abortListener;
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(TelegramOwnerSelector._abortError());
      options.signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      options.signal.removeEventListener('abort', abortListener);
    }
  }

  async chooseOwner(request) {
    const deadline = this.now() + this.timeoutMs;
    const flow = this._createFlowSignal(request.signal, deadline);
    try {
      const ended = this._endedResult(request.signal, flow, deadline);
      if (ended) return ended;
      return await this._chooseOwner({
        ...request,
        signal: flow.signal,
        callerSignal: request.signal,
        flow,
        deadline,
      });
    } catch (error) {
      const ended = this._endedResult(request.signal, flow, deadline);
      if (ended) return ended;
      return { status: 'error', message: error.message };
    } finally {
      flow.cleanup();
    }
  }

  static _abortError() {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
  }

  _createFlowSignal(callerSignal, deadline) {
    const controller = new AbortController();
    let reason = null;
    const abort = nextReason => {
      if (controller.signal.aborted) return;
      reason = nextReason;
      controller.abort();
    };
    const onCallerAbort = () => abort('caller');

    if (callerSignal?.aborted) onCallerAbort();
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    const delay = Math.max(0, deadline - this.now());
    const timer = setTimeout(() => abort('deadline'), delay);
    timer.unref?.();

    return {
      signal: controller.signal,
      reason: () => reason,
      cleanup: () => {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
      },
    };
  }

  _endedResult(callerSignal, flow, deadline) {
    if (callerSignal?.aborted || flow.reason() === 'caller') {
      return { status: 'cancelled' };
    }
    if (flow.reason() === 'deadline' || this.now() >= deadline) {
      return { status: 'timeout' };
    }
    return null;
  }

  async _chooseOwner({
    ticketNumber,
    candidates,
    signal,
    callerSignal,
    flow,
    deadline,
  }) {
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
    }, { signal });
    let ended = this._endedResult(callerSignal, flow, deadline);
    if (ended) return ended;

    while (this.now() < deadline) {
      const updates = await this._call('getUpdates', {
        offset: this.updateOffset,
        timeout: 20,
        allowed_updates: ['callback_query'],
      }, { signal });
      ended = this._endedResult(callerSignal, flow, deadline);
      if (ended) return ended;

      for (const update of updates) {
        this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
        const query = update.callback_query;
        if (!query) continue;
        const [prefix, callbackNonce, candidateKey] = String(query.data || '').split(':');
        if (
          prefix !== 'owner' || callbackNonce !== nonce ||
          String(query.message?.chat?.id) !== this.chatId || !allowed.has(candidateKey)
        ) continue;
        await this._call('answerCallbackQuery', { callback_query_id: query.id }, { signal });
        ended = this._endedResult(callerSignal, flow, deadline);
        if (ended) return ended;
        return { status: 'selected', candidateKey };
      }
    }
    return { status: 'timeout' };
  }
}

module.exports = TelegramOwnerSelector;
