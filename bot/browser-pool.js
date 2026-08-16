'use strict';

class BrowserPool {
  constructor({ launch }) {
    this._launch = launch;
    this._browser = null;
    this._launchPromise = null;
    this._closePromise = null;
  }

  async acquire() {
    const browser = await this._getBrowser();
    let released = false;
    return {
      browser,
      release: async () => {
        if (released) return;
        released = true;
      },
    };
  }

  async _getBrowser() {
    if (this._browser && this._isConnected(this._browser)) return this._browser;
    if (this._launchPromise) return this._launchPromise;

    this._launchPromise = Promise.resolve()
      .then(() => this._launch())
      .then(browser => {
        this._browser = browser;
        return browser;
      })
      .finally(() => { this._launchPromise = null; });
    return this._launchPromise;
  }

  _isConnected(browser) {
    return typeof browser.isConnected !== 'function' || browser.isConnected();
  }

  async close() {
    if (this._closePromise) return this._closePromise;
    this._closePromise = Promise.resolve(this._launchPromise)
      .catch(() => null)
      .then(async () => {
        const browser = this._browser;
        this._browser = null;
        if (browser) await browser.close();
      })
      .finally(() => { this._closePromise = null; });
    return this._closePromise;
  }
}

module.exports = BrowserPool;
