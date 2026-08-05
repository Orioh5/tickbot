'use strict';

class MaccabiAuthenticator {
  constructor({ browserFactory } = {}) {
    this.browserFactory = browserFactory || (async () => {
      const { chromium } = require('playwright');
      return chromium.launch({ headless: true });
    });
  }

  async login(username, password) {
    const browser = await this.browserFactory();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto('https://auth.mhaifafc.com/', { waitUntil: 'networkidle', timeout: 45_000 });
      await page.fill('input[type="email"], input[name="email"], input[name="username"], input[type="text"]', username);
      await page.fill('input[type="password"]', password);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 45_000 }).catch(() => null),
        page.click('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("התחבר")'),
      ]);

      const passwordFields = await page.locator('input[type="password"]:visible').count();
      const storageState = await context.storageState();
      if (passwordFields > 0 || !Array.isArray(storageState.cookies) || storageState.cookies.length === 0) {
        throw new Error('Login credentials were not accepted');
      }
      return storageState;
    } finally {
      await browser.close();
    }
  }
}

module.exports = MaccabiAuthenticator;
