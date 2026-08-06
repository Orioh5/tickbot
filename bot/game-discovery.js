'use strict';

// Navigates to the Maccabi Haifa ticketing events page using the user's saved session
// and returns a list of available games. Also supports discovering available sections
// on a specific game page.

const EVENTS_URL = 'https://tickets.mhaifafc.com/';
const NAV_OPTS = { waitUntil: 'networkidle', timeout: 45_000 };
const { makeSalesArea, mergeSalesAreas } = require('./sales-area');

function sessionExpiredError() {
  return Object.assign(new Error('Saved session expired'), { code: 'SESSION_EXPIRED' });
}

async function assertAuthenticated(page) {
  let redirectedToLogin = false;
  try {
    const currentUrl = new URL(page.url());
    redirectedToLogin = currentUrl.hostname === 'auth.mhaifafc.com'
      && /^\/login(?:\/|$)/i.test(currentUrl.pathname);
  } catch (_) {
    // A malformed or unavailable URL is not proof that authentication was lost.
  }

  const loginFormVisible = await page
    .locator('form:has(input[type="password"])')
    .first()
    .isVisible();
  if (redirectedToLogin || loginFormVisible) throw sessionExpiredError();
}

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
      await assertAuthenticated(page);
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
      await assertAuthenticated(page);
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

  async discoverEventMap(userId, game) {
    const storageState = this.userSessionStore.load(userId);
    if (!storageState) throw new Error('No saved session. Use /login first.');
    const browser = await this.browserFactory(storageState);
    try {
      const context = await browser.newContext({ storageState });
      const page = await context.newPage();
      await page.goto(game.url, NAV_OPTS);
      await assertAuthenticated(page);
      const snapshot = await page.evaluate(() => ({
        venueName: document
          .querySelector('[data-venue], .venue, .stadium-name')
          ?.textContent?.trim() || null,
        mapLoaded: Boolean(document.querySelector('svg')),
        clickable: Array.from(
          document.querySelectorAll('[onclick*="processSectorById"]')
        ).map(element => ({
          id: (element.getAttribute('onclick') || '')
            .match(/processSectorById\((\d+)\)/)?.[1] || null,
          label: element.textContent.trim(),
        })).filter(area => area.id && /\d/.test(area.label)),
        mapLabels: Array.from(document.querySelectorAll(
          'svg text, svg [data-sector-label], svg [data-sector-name], [data-sector-label], [data-sector-name]'
        )).map(element =>
          element.getAttribute('data-sector-label') ||
          element.getAttribute('data-sector-name') ||
          element.textContent
        ).map(text => text?.trim()).filter(text => /\d/.test(text || '')),
      }));

      const clickable = Array.isArray(snapshot?.clickable)
        ? snapshot.clickable.map(area => makeSalesArea({
          ...area,
          available: true,
          source: 'dom',
        }))
        : [];
      const mapAreas = Array.isArray(snapshot?.mapLabels)
        ? snapshot.mapLabels.map(label => makeSalesArea({
          label,
          available: false,
          source: 'svg',
        }))
        : [];
      const areas = mergeSalesAreas([...mapAreas, ...clickable]);
      const confidence = areas.length === 0
        ? 'unknown'
        : (mapAreas.length > 0 ? 'complete' : 'partial');
      let eventId = null;
      try {
        const parsed = new URL(game.url);
        eventId = parsed.searchParams.get('eventId');
      } catch (_) {}

      await context.close();
      return {
        eventId,
        gameName: game.name,
        gameUrl: game.url,
        venueName: snapshot?.venueName || null,
        confidence,
        areas,
      };
    } finally {
      await browser.close();
    }
  }
}

module.exports = GameDiscoveryService;
