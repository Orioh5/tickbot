'use strict';

class MaccabiAuthenticator {
  constructor({ browserFactory } = {}) {
    this.browserFactory = browserFactory || (async () => {
      const { chromium } = require('playwright');
      return chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      });
    });
  }

  async login(username, password) {
    const browser = await this.browserFactory();
    try {
      const chromiumVersion = browser.version?.() || '141.0.0.0';
      const chromeMajor = String(chromiumVersion).split('.')[0];
      const context = await browser.newContext({
        userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
          `(KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
        locale: 'he-IL',
        viewport: { width: 1366, height: 768 },
      });
      const page = await context.newPage();
      await page.goto('https://auth.mhaifafc.com/login', { waitUntil: 'networkidle', timeout: 45_000 });
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
