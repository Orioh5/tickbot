'use strict';

// Navigates to the Maccabi Haifa ticketing events page using the user's saved session
// and returns a list of available games. Also supports discovering available sections
// on a specific game page.

const EVENTS_URL = 'https://tickets.mhaifafc.com/';
const NAV_OPTS = { waitUntil: 'networkidle', timeout: 45_000 };

class GameDiscoveryService {
  constructor({ userSessionStore, browserFactory }) {
    this.userSessionStore = userSessionStore;
    // browserFactory(storageState) → Playwright browser or compatible stub
    this.browserFactory = browserFactory;
  }

  async discoverGames(userId) {
    const storageState = this.userSessionStore.load(userId);
    if (!storageState) throw new Error('No saved session. Use /login first.');
    const browser = await this.browserFactory(storageState);
    try {
      const context = await browser.newContext({ storageState });
      const page = await context.newPage();
      await page.goto(EVENTS_URL, NAV_OPTS);
      const games = await page.evaluate(() => {
        // Each event is a link with a title; selector may need refinement per site structure
        return Array.from(document.querySelectorAll('a[href*="/event/"], a[href*="/EventPage/"]'))
          .map(a => ({
            name: a.querySelector('.event-name, .title, h3, h4')?.textContent?.trim() || a.textContent?.trim(),
            url: a.href,
          }))
          .filter(g => g.name && g.url);
      });
      await context.close();
      return games;
    } finally {
      await browser.close();
    }
  }

  async discoverSections(userId, gameUrl) {
    const storageState = this.userSessionStore.load(userId);
    if (!storageState) throw new Error('No saved session. Use /login first.');
    const browser = await this.browserFactory(storageState);
    try {
      const context = await browser.newContext({ storageState });
      const page = await context.newPage();
      await page.goto(gameUrl, NAV_OPTS);
      // Uses same extraction logic as monitor._checkAvailability
      const sections = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[onclick*="processSectorById"]'))
          .map(el => {
            const m = (el.getAttribute('onclick') || '').match(/processSectorById\((\d+)\)/);
            if (!m) return null;
            const labelMatch = el.textContent.trim().match(/(\d+)/);
            return { id: m[1], label: labelMatch ? labelMatch[1] : m[1] };
          })
          .filter(Boolean)
      );
      await context.close();
      return sections;
    } finally {
      await browser.close();
    }
  }
}

module.exports = GameDiscoveryService;
