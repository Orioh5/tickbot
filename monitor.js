// monitor.js — Playwright monitoring logic

const EventEmitter = require('events');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const TelegramOwnerSelector = require('./telegram-owner-selector');
const ownerAssignment = require('./owner-assignment');

const STATE_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'state.json')
  : path.join(__dirname, 'state.json');

function sessionExpiredError() {
  return Object.assign(new Error('Saved session expired'), { code: 'SESSION_EXPIRED' });
}

function parseAvailableSections(candidates) {
  return candidates
    .map(({ onclick = '', text = '' }) => {
      const idMatch = onclick.match(/processSectorById\((\d+)\)/);
      if (!idMatch) return null;
      const labelMatch = text.trim().match(/(\d+)/);
      return { id: idMatch[1], label: labelMatch ? labelMatch[1] : idMatch[1] };
    })
    .filter(Boolean);
}

function buildSectorsInfoUrl(eventUrl) {
  const parsed = new URL(eventUrl);
  const eventId = parsed.searchParams.get('eventId');
  if (!eventId || !/^\d+$/.test(eventId)) {
    throw new Error('Event URL does not contain a valid eventId');
  }

  const apiUrl = new URL('/Stadium/GetWGLSectorsInfo', parsed.origin);
  apiUrl.searchParams.set('eventId', eventId);
  return apiUrl.toString();
}

function parseSectorsInfo(payload) {
  if (!payload || !Array.isArray(payload.sectors)) {
    throw new Error('Invalid sectors-info response');
  }

  return {
    timestamp: payload.timestamp || null,
    sectors: payload.sectors.map(sector => ({
      id: String(sector.id),
      freeSeats: Array.isArray(sector.freeSeatsByPriceArea)
        ? sector.freeSeatsByPriceArea.reduce((total, area) => total + Number(area.freeSeatsNo || 0), 0)
        : 0,
    })),
  };
}

function buildNotificationText(settings, message, {
  checkoutReady = false,
  inspectCart = false,
} = {}) {
  const checkoutUrl = new URL('/Transaction2/Edit', settings.url).toString();
  const checkout = checkoutReady
    ? `\n\n💳 Cart is ready — continue to payment:\n${checkoutUrl}`
    : (inspectCart
      ? `\n\n🛒 Open the cart to inspect it manually:\n${checkoutUrl}`
      : '');
  return `${message}${checkout}\n\n🔑 Login & go straight there:\n${settings.loginUrl}?redirectUrl=${encodeURIComponent(settings.url)}\n\n🎟️ Direct event link:\n${settings.url}`;
}

class Monitor extends EventEmitter {
  constructor({ ownerSelectorFactory, ownerBrowser, notificationFetch, browserLeaseFactory } = {}) {
    super();
    this.running = false;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.sections = {};
    this.stats = { checks: 0, alerts: 0, errors: 0, startedAt: null, lastCheck: null };
    this._labelToOnclickId = {};
    this._onclickIdToLabel = {};
    this.settings = null;
    this._stopRequested = false;
    this._browserCleanupPromises = new WeakMap();
    this._queueDetected = false;
    this._sectorsInfoUrl = null;
    this._sectorsInfoHeaders = null;
    this._sectorsInfoReady = null;
    this._resolveSectorsInfo = null;
    this._ownerSelectorFactory = ownerSelectorFactory || (settings =>
      new TelegramOwnerSelector({
        token: settings.telegramToken,
        chatId: settings.telegramChatId,
      })
    );
    this._ownerBrowser = ownerBrowser || {
      discover: ownerAssignment.discoverOwnerCandidates,
      apply: ownerAssignment.applyOwnerCandidate,
    };
    this._ownerSelector = null;
    this._ownerSelectionAbort = null;
    this._notificationFetch = notificationFetch || fetch;
    this._browserLeaseFactory = browserLeaseFactory || null;
    this._browserLease = null;
    this._phase = 'stopped';
    this._flowToken = null;
    this._loopPromise = null;
    this._startInFlight = false;
    this._sessionExpiryReported = false;
  }

  log(message, level = 'info') {
    console.log(`[${level.toUpperCase()}] ${message}`);
    this.emit('log', message, level);
  }

  getStatus() {
    const phase = this._phase === 'stopped' && this.running ? 'monitoring' : this._phase;
    return {
      running: this.running,
      busy: this.running || phase !== 'stopped' || Boolean(this.browser) ||
        Boolean(this._loopPromise) || this._startInFlight,
      phase,
      startedAt: this.stats.startedAt,
      lastCheck: this.stats.lastCheck,
    };
  }

  getSections() {
    return { ...this.sections };
  }

  getStats() {
    return { ...this.stats };
  }

  _setPhase(phase) {
    this._phase = phase;
    this.emit('status', this.getStatus());
  }

  _finalizeFlow(flowToken = this._flowToken) {
    if (flowToken && this._flowToken !== flowToken) return;
    this.running = false;
    this._phase = 'stopped';
    this._flowToken = null;
    this._loopPromise = null;
    this._startInFlight = false;
    this._ownerSelector = null;
    this._ownerSelectionAbort = null;
    this.browser = null;
    this.context = null;
    this.page = null;
    this._browserLease = null;
    this.emit('status', this.getStatus());
  }

  async start(settings) {
    if (this.getStatus().busy) {
      const error = new Error('Monitor is busy with an active browser or cart flow');
      error.code = 'MONITOR_BUSY';
      this.log(error.message, 'warning');
      throw error;
    }

    const ownerSelectionAbort = new AbortController();
    const ownerSelector = this._ownerSelectorFactory(settings);
    const flowToken = {};
    this._stopRequested = false;
    this._queueDetected = false;
    this._sectorsInfoUrl = null;
    this._sectorsInfoHeaders = null;
    this._sectorsInfoReady = null;
    this._resolveSectorsInfo = null;
    this._sessionExpiryReported = false;
    this._labelToOnclickId = {};
    this._onclickIdToLabel = {};
    this.settings = settings;
    this._ownerSelectionAbort = ownerSelectionAbort;
    this._ownerSelector = ownerSelector;
    this._flowToken = flowToken;
    this._startInFlight = true;

    // Init section states
    this.sections = {};
    for (const s of settings.sections) {
      this.sections[s] = { status: 'pending' };
    }

    this.stats = { checks: 0, alerts: 0, errors: 0, startedAt: new Date().toISOString(), lastCheck: null };
    this.running = true;
    this._phase = 'starting';

    this.emit('status', this.getStatus());
    this.emit('sections', this.getSections());
    this.emit('stats', this.getStats());

    this.log('Initializing browser...', 'info');

    try {
      await this._launch();
      const launchedBrowser = this.browser;
      const launchIsStale = this._flowToken !== flowToken || this._stopRequested ||
        this._ownerSelectionAbort !== ownerSelectionAbort;
      if (launchIsStale) {
        await this._cleanupBrowser(launchedBrowser, ownerSelectionAbort);
        this._finalizeFlow(flowToken);
        return;
      }

      this.log('Browser ready. Starting monitoring loop...', 'success');
      this._startInFlight = false;
      this._setPhase('monitoring');
      const loopPromise = this._runLoop(flowToken);
      this._loopPromise = loopPromise;
      void loopPromise.finally(() => this._finalizeFlow(flowToken)).catch(() => {});
    } catch (e) {
      this.log('Browser startup failed code=MONITOR_START_FAILED.', 'error');
      this.running = false;
      await this._cleanupBrowser(this.browser, ownerSelectionAbort);
      this._finalizeFlow(flowToken);
      throw e;
    }
  }

  async stop() {
    const flowToken = this._flowToken;
    const browser = this.browser;
    const ownerSelectionAbort = this._ownerSelectionAbort;
    const loopPromise = this._loopPromise;
    const startInFlight = this._startInFlight;
    this._stopRequested = true;
    ownerSelectionAbort?.abort();
    if (!this.getStatus().busy && !browser) return;
    this.running = false;
    this._setPhase('stopping');

    await this._cleanupBrowser(browser, ownerSelectionAbort);
    if (!loopPromise && !startInFlight) this._finalizeFlow(flowToken);

    this.log('Monitor stopped.', 'info');
  }

  async _cleanupBrowser(
    browser = this.browser,
    ownerSelectionAbort = this._ownerSelectionAbort
  ) {
    ownerSelectionAbort?.abort();
    if (!browser) return;

    const ownsCurrentBrowser = this.browser === browser;
    const context = ownsCurrentBrowser ? this.context : null;
    const lease = ownsCurrentBrowser ? this._browserLease : null;

    // Only clear the shared references if they still belong to this browser. This
    // prevents an old loop finishing from clearing a newly-started browser.
    if (ownsCurrentBrowser) {
      this.browser = null;
      this.context = null;
      this.page = null;
      this._browserLease = null;
    }

    let cleanup = this._browserCleanupPromises.get(browser);
    if (!cleanup) {
      cleanup = Promise.resolve()
        .then(() => context?.close?.())
        .then(() => lease ? lease.release() : browser.close())
        .catch(() => {});
      this._browserCleanupPromises.set(browser, cleanup);
    }
    await cleanup;
  }

  // ── Browser ──────────────────────────────────────────────────────────────

  async _launch() {
    const s = this.settings;

    // Try playwright-extra + stealth, fall back to plain playwright
    let pw;
    try {
      const extra = require('playwright-extra');
      const stealth = require('playwright-extra-plugin-stealth');
      extra.use(stealth());
      pw = extra;
      this.log('Using playwright-extra with stealth plugin', 'info');
    } catch (_) {
      pw = require('playwright');
      this.log('Using standard Playwright (no stealth)', 'info');
    }

    const launchOpts = {
      headless: !s.headful,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    };

    if (s.proxyServer) {
      launchOpts.proxy = {
        server: s.proxyServer,
        ...(s.proxyUsername && { username: s.proxyUsername }),
        ...(s.proxyPassword && { password: s.proxyPassword }),
      };
    }

    if (this._browserLeaseFactory) {
      this._browserLease = await this._browserLeaseFactory();
      this.browser = this._browserLease.browser;
    } else {
      this.browser = await pw.chromium.launch(launchOpts);
    }

    const ctxOpts = {
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'he-IL',
    };

    if (s.storageState) {
      ctxOpts.storageState = s.storageState;
      this.log('Loaded per-user saved session', 'info');
    } else if (fs.existsSync(STATE_PATH)) {
      try {
        ctxOpts.storageState = STATE_PATH;
        this.log('Loaded saved session', 'info');
      } catch (_) {}
    }

    this.context = await this.browser.newContext(ctxOpts);

    // Only block media — images/fonts needed for seat map to render
    await this.context.route('**/*', route => {
      if (route.request().resourceType() === 'media') {
        route.abort();
      } else {
        route.continue();
      }
    });

    this.page = await this.context.newPage();
    this._sectorsInfoReady = new Promise(resolve => { this._resolveSectorsInfo = resolve; });

    // Intercept API responses for availability data
    this.page.on('response', async response => {
      const url = response.url();
      if (url.includes('/Stadium/GetWGLSectorsInfo?')) {
        this._sectorsInfoUrl = url;
        const headers = response.request?.().headers?.() || {};
        this._sectorsInfoHeaders = {
          ...(headers.accept && { Accept: headers.accept }),
          ...(headers['x-theme-id'] && { 'X-Theme-Id': headers['x-theme-id'] }),
          ...(headers['x-color-id'] && { 'X-Color-Id': headers['x-color-id'] }),
        };
        this._resolveSectorsInfo?.();
        this._resolveSectorsInfo = null;
      }
      if (url.includes('availability') || url.includes('SeatMap') || url.includes('blocks') || url.includes('seats')) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json')) {
            const data = await response.json().catch(() => null);
            if (data) this.emit('apiData', data);
          }
        } catch (_) {}
      }
    });

    if (s.loginUsername && s.loginPassword) {
      await this._login();
    }
  }

  async _login() {
    const s = this.settings;
    try {
      this.log('Navigating to login page...', 'info');
      await this.page.goto(s.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this._sleep(1500);

      const emailSel = 'input[type="email"], input[name="email"], input[name="username"]';
      const passSel  = 'input[type="password"]';

      await this.page.fill(emailSel, s.loginUsername);
      await this.page.fill(passSel, s.loginPassword);
      await this.page.click(
        'button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("התחבר")'
      );

      await this.page.waitForNavigation({ timeout: 15000 }).catch(() => {});
      await this._sleep(1000);

      await this.context.storageState({ path: STATE_PATH });
      this.log('Login successful, session saved', 'success');
    } catch (e) {
      this.log('Login attempt failed code=LOGIN_ATTEMPT_FAILED; continuing with the saved session.', 'warning');
    }
  }

  // ── Main loop ─────────────────────────────────────────────────────────────

  async _fetchApiAvailability() {
    if (!this.context?.request) throw new Error('Browser request context is not available');

    const apiUrl = this._sectorsInfoUrl || buildSectorsInfoUrl(this.settings.url);
    const response = await this.context.request.post(apiUrl, {
      headers: {
        ...(this._sectorsInfoHeaders || {}),
        Origin: new URL(this.settings.url).origin,
        Referer: this.settings.url,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    if (!response.ok()) {
      throw new Error(`Sectors API returned HTTP ${response.status()}`);
    }

    const responseBody = await response.text();
    if (!responseBody.trim()) {
      throw new Error(`Sectors API returned an empty response (HTTP ${response.status()})`);
    }

    const payload = JSON.parse(responseBody);
    this.emit('apiData', { url: apiUrl, data: payload });
    return parseSectorsInfo(payload);
  }

  async _assertSessionActive() {
    if (!this.page) return;
    let redirectedToLogin = false;
    try {
      const currentUrl = new URL(this.page.url());
      redirectedToLogin = currentUrl.hostname === 'auth.mhaifafc.com'
        && /^\/login(?:\/|$)/i.test(currentUrl.pathname);
    } catch (_) {
      // URL failures alone are not proof that the saved session expired.
    }

    const loginForm = this.page.locator?.('form:has(input[type="password"])')?.first?.();
    const loginFormVisible = loginForm ? await loginForm.isVisible() : false;
    if (redirectedToLogin || loginFormVisible) throw sessionExpiredError();
  }

  _reportSessionExpired(error) {
    if (this._sessionExpiryReported) return;
    this._sessionExpiryReported = true;
    this.running = false;
    this._setPhase('session-expired');
    this.log('Saved session expired; reconnect is required.', 'warning');
    this.emit('sessionExpired', error);
  }

  async _refreshDomAvailability(reason) {
    this.log(`${reason} Refreshing the event page once...`, 'warning');
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await this._waitForSeatMapOrLogin();
    await this._assertSessionActive();
    return this._checkAvailability();
  }

  async _waitForSeatMapOrLogin() {
    if (this._sectorsInfoReady) {
      if (typeof this.page?.waitForSelector !== 'function') {
        await this._sectorsInfoReady;
        return;
      }
      await Promise.race([
        this._sectorsInfoReady,
        this.page.waitForSelector(
          '#queueit_overlay, [id*="queueit"], form:has(input[type="password"])',
          { state: 'attached', timeout: 15_000 }
        ).catch(() => null),
      ]);
      return;
    }
    if (typeof this.page?.waitForSelector !== 'function') return;
    await this.page.waitForSelector(
      '#mainStadium canvas, [onclick*="processSectorById"], form:has(input[type="password"])',
      { state: 'attached', timeout: 15_000 }
    );
  }

  async _pollApiAvailability() {
    const result = await this._fetchApiAvailability();
    const availableApiSectors = result.sectors.filter(sector => sector.freeSeats > 0);
    const configured = new Set(this.settings.sections.map(String));
    const unmapped = availableApiSectors.filter(sector =>
      !this._onclickIdToLabel[sector.id] && !configured.has(sector.id)
    );

    if (unmapped.length > 0) {
      return this._refreshDomAvailability(
        `API found ${unmapped.length} available sector ID(s) that need visual-label mapping.`
      );
    }

    const availableSections = availableApiSectors.map(sector => ({
      id: sector.id,
      label: this._onclickIdToLabel[sector.id] || sector.id,
      freeSeats: sector.freeSeats,
    }));

    const newlyAvailableForPurchase = availableSections.some(sector => {
      const watched = configured.has(sector.label) || configured.has(sector.id);
      const previous = this.sections[sector.label] || this.sections[sector.id];
      return watched && previous?.status !== 'available';
    });
    if (newlyAvailableForPurchase) {
      return this._refreshDomAvailability('API found tickets for auto-purchase.');
    }

    const summary = availableSections.length
      ? availableSections.map(sector => `${sector.label}:${sector.freeSeats}`).join(', ')
      : 'none';
    this.log(`API availability [${summary}]${result.timestamp ? ` at ${result.timestamp}` : ''}`, 'info');
    return this._applyAvailability(availableSections);
  }

  async _pollApiOrFallback() {
    try {
      return await this._pollApiAvailability();
    } catch (error) {
      if (error?.code === 'SESSION_EXPIRED') throw error;
      return this._refreshDomAvailability('API polling failed code=AVAILABILITY_API_FAILED.');
    }
  }

  async _runLoop(flowToken = null) {
    let consecutiveErrors = 0;
    let navigated = false;
    const loopBrowser = this.browser;
    const loopOwnerSelectionAbort = this._ownerSelectionAbort;

    try {
      const flowIsActive = () => this.running && !this._stopRequested &&
        (!flowToken || this._flowToken === flowToken);
      while (flowIsActive()) {
        try {
          if (!navigated) {
            this.log('Loading event page...', 'info');
            await this.page.goto(this.settings.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await this._waitForSeatMapOrLogin();
            await this._assertSessionActive();
            await this._checkAvailability();
            navigated = true;
          } else {
            await this._pollApiOrFallback();
          }
          consecutiveErrors = 0;

        } catch (e) {
          if (!flowIsActive()) break;
          if (e?.code === 'SESSION_EXPIRED') {
            this._reportSessionExpired(e);
            break;
          }
          consecutiveErrors++;
          this.stats.errors++;
          this.emit('stats', this.getStats());
          this.log(`Monitoring check failed (${consecutiveErrors}/3) code=MONITOR_POLL_FAILED.`, 'error');

          if (consecutiveErrors >= 3) {
            this.log('Too many errors — waiting 60s before retry...', 'warning');
            for (let i = 0; i < 60 && flowIsActive(); i++) await this._sleep(1000);
            consecutiveErrors = 0;
            navigated = false;
          }
        }

        if (flowIsActive()) await this._sleep(this.settings.intervalMs);
      }
    } finally {
      await this._cleanupBrowser(loopBrowser, loopOwnerSelectionAbort);
    }
  }

  async _checkAvailability() {
    if (!this.page) return;

    // Check for Queue-it
    const isQueued = await this.page.evaluate(() =>
      !!(document.querySelector('#queueit_overlay') ||
         document.querySelector('[id*="queueit"]') ||
         window.location.href.includes('queue-it'))
    ).catch(() => false);

    if (isQueued) {
      if (!this._queueDetected) {
        this._queueDetected = true;
        this.log('Queue-it detected! You are in a queue.', 'warning');
        await this._notify('⚠️ Queue-it detected — you\'re in a queue!');
      }
      return;
    }

    if (this._queueDetected) {
      this._queueDetected = false;
      this.log('Queue-it cleared. Resuming availability checks.', 'success');
    }

    // Read available sections from the page — sections appear in the LI list only when available
    // Extract BOTH the onclick internal ID and the visual block label from text content.
    // The ticketing site uses large internal IDs (e.g. 1590) in onclick but shows small visual
    // numbers (e.g. 13) on the map and in the element text ("גוש 13"). Users type visual numbers,
    // so we compare against labels; onclick IDs are kept as a fallback for advanced users.
    const snapshot = await this.page.evaluate(() => ({
      mapLoaded: !!document.querySelector('#mainStadium canvas'),
      candidates: Array.from(document.querySelectorAll('[onclick*="processSectorById"]'))
        .map(el => ({
          onclick: el.getAttribute('onclick') || '',
          text: el.textContent || '',
        })),
    })).catch(() => null);

    if (!snapshot?.mapLoaded) {
      throw new Error('Seat map did not load; availability result is not trustworthy');
    }

    const availableOnPage = parseAvailableSections(snapshot.candidates);

    const onPageSummary = availableOnPage.length
      ? availableOnPage.map(s => s.label !== s.id ? `${s.label} (id:${s.id})` : s.id).join(', ')
      : 'none';
    this.log(`Sections on page: [${onPageSummary}]`, 'info');

    // Map from visual label (and onclick ID) → internal onclick ID, for auto-purchase clicks
    for (const s of availableOnPage) {
      this._labelToOnclickId[s.label] = s.id;
      this._labelToOnclickId[s.id]    = s.id;
      this._onclickIdToLabel[s.id]    = s.label;
    }

    return this._applyAvailability(availableOnPage);
  }

  async _applyAvailability(availableSections) {
    // Snapshot previous section statuses before this check cycle, so we can detect transitions
    const prevSections = { ...this.sections };

    for (const s of this.settings.sections) {
      this.sections[s] = { status: 'checking' };
    }
    this.emit('sections', this.getSections());

    const availableLabels = new Set(availableSections.map(s => s.label));
    const availableIds    = new Set(availableSections.map(s => s.id));

    for (const section of this.settings.sections) {
      const sec = String(section);
      const match = availableSections.find(item => item.label === sec || item.id === sec);
      this.sections[section] = {
        status: (availableLabels.has(sec) || availableIds.has(sec)) ? 'available' : 'unavailable',
        ...(match && Number.isFinite(match.freeSeats) ? { freeSeats: match.freeSeats } : {}),
      };
    }

    this.stats.checks++;
    this.stats.lastCheck = new Date().toISOString();
    this.emit('sections', this.getSections());
    this.emit('stats', this.getStats());

    // Detect state transitions — only alert when a section changes state, not on every check
    const nowAvailable   = new Set(Object.entries(this.sections).filter(([, v]) => v.status === 'available').map(([k]) => k));
    const wasAvailable   = new Set(Object.entries(prevSections).filter(([, v]) => v.status === 'available').map(([k]) => k));
    const newlyAvailable   = [...nowAvailable].filter(k => !wasAvailable.has(k));
    const newlyUnavailable = [...wasAvailable].filter(k => !nowAvailable.has(k));

    if (newlyAvailable.length > 0) {
      const purchaseResult = await this._tryAutoPurchase(newlyAvailable[0]);

      this.stats.alerts++;
      this.emit('stats', this.getStats());
      const manualRecovery = purchaseResult.assignments === 'manual';
      const msg = purchaseResult.cartReady
        ? `🛒 Tickets added to cart! Section ${newlyAvailable[0]} — complete checkout now!`
        : (manualRecovery
          ? '⚠️ Cart contents could not be verified. Use the manual cart link to review it.'
          : `🎟️ Tickets available in sections: ${newlyAvailable.join(', ')}!`);
      this.log(msg, 'alert');
      this.emit('alert', msg);
      if (!purchaseResult.cartReady && !manualRecovery) {
        await this._notify(msg);
      }

      if (this.settings.pauseOnHit && this.running) {
        this.log('Pausing — tickets found! Stop and restart to continue.', 'warning');
        this.running = false;
        this.emit('status', this.getStatus());
      }
    } else if (newlyUnavailable.length > 0) {
      // Tickets were available but are now gone — send one notification
      const msg = `❌ Tickets no longer available in sections: ${newlyUnavailable.join(', ')}`;
      this.log(msg, 'warning');
      this.emit('alert', msg);
      await this._notify(msg);
    }

    if (nowAvailable.size === 0 && newlyAvailable.length === 0) {
      this.log(`Check #${this.stats.checks}: No availability in ${this.settings.sections.length} sections`, 'info');
    }
  }

  async _tryAutoPurchase(sectionId) {
    if (!this.page) return { cartReady: false, assignments: 'failed' };
    let cartReady = false;
    let confirmationAttempted = false;
    const previousPhase = this._phase;
    try {
      this._setPhase('cart-interaction');
      this.log(`Auto-purchase: clicking section ${sectionId}...`, 'info');

      // Resolve visual label → internal onclick ID (e.g. "13" → "1590")
      const onclickId = (this._labelToOnclickId || {})[String(sectionId)] || String(sectionId);

      // Click the section element
      const sectorActivated = await this.page.evaluate(id => {
        const sector = Array.from(
          document.querySelectorAll('[onclick*="processSectorById"]')
        ).find(element => {
          const match = (element.getAttribute('onclick') || '')
            .match(/processSectorById\((\d+)\)/);
          return match?.[1] === String(id);
        });
        if (!sector) return false;
        sector.click();
        return true;
      }, onclickId);
      if (!sectorActivated) {
        this.log('Auto-purchase: section element not found on page', 'warning');
        this._restoreScanningPhase(previousPhase);
        return { cartReady: false, assignments: 'failed' };
      }

      // The stadium page opens this specific GA quantity dialog. Generic modal
      // selectors also match permanent accessibility dialogs on the page.
      await this.page.waitForSelector('#seatCountModal', {
        state: 'visible',
        timeout: 6000,
      });

      const target = Math.max(1, this.settings.desiredQuantity || 1);
      await this.page.locator('#scount').fill(String(target));

      // #fnFastSeats posts the reservation and then navigates to the URL
      // returned by the server. Wait for that official flow to finish instead
      // of racing it with a separate page.goto().
      confirmationAttempted = true;
      this.running = false;
      this._setPhase('cart-verification');
      const checkoutUrl = new URL('/Transaction2/Edit', this.settings.url).toString();
      const reservationResponsePromise = this.page.waitForResponse(
        response =>
          response.url().includes('/Stadium/GetWglAutoSeats') &&
          response.request().method() === 'POST',
        { timeout: 45000 }
      );
      const cartNavigationPromise = this.page.waitForURL(checkoutUrl, {
        waitUntil: 'networkidle',
        timeout: 45000,
      });
      await this.page.click('#fnFastSeats');
      const [reservationResponse] = await Promise.all([
        reservationResponsePromise,
        cartNavigationPromise,
      ]);
      if (!reservationResponse.ok()) {
        throw new Error(`Seat reservation failed with HTTP ${reservationResponse.status()}`);
      }
      await this._verifyCart(checkoutUrl, target);

      cartReady = true;
      this._setPhase('owner-selection');
      this.log(`Auto-purchase: section ${sectionId} added to cart!`, 'success');
      const assignmentResult = await this._finishCartOwnerFlow();
      return { cartReady: true, assignments: assignmentResult.status };
    } catch (e) {
      this.log('Cart automation failed code=CART_AUTOMATION_FAILED.', 'error');
      if (confirmationAttempted) {
        if (!this._stopRequested) this._setPhase(cartReady ? 'cart-ready' : 'cart-recovery');
        const fallbackMessage = cartReady
          ? '⚠️ לא ניתן להשלים את השיוך אוטומטית. יש להשלים ידנית בסל.'
          : '⚠️ לא ניתן לאמת את תוכן הסל. יש לבדוק ולהשלים ידנית בסל.';
        await this._sendCartRecovery(fallbackMessage, { verifiedCart: cartReady });
        return { cartReady, assignments: 'manual' };
      }
      this._restoreScanningPhase(previousPhase);
      return { cartReady: false, assignments: 'failed' };
    }
  }

  _restoreScanningPhase(previousPhase) {
    if (this._stopRequested || !this.running) return;
    this._setPhase(previousPhase === 'stopped' ? 'monitoring' : previousPhase);
  }

  async _verifyCart(expectedCheckoutUrl, desiredQuantity) {
    const actualUrl = new URL(this.page.url());
    const expectedUrl = new URL(expectedCheckoutUrl);
    if (actualUrl.origin !== expectedUrl.origin || actualUrl.pathname !== expectedUrl.pathname) {
      throw new Error('Cart navigation was redirected away from the expected cart');
    }

    const ticketCount = await this.page.locator('.transaction-ticket').count();
    if (ticketCount < desiredQuantity) {
      throw new Error(`Cart contains ${ticketCount} ticket(s), expected at least ${desiredQuantity}`);
    }
    return ticketCount;
  }

  async _completeOwnerAssignments() {
    let ticketNumber = 1;
    while (!this._stopRequested) {
      const discovered = await this._ownerBrowser.discover(this.page);
      if (!discovered.required) return { status: 'complete' };
      let remaining = discovered.candidates;

      while (remaining.length > 0 && !this._stopRequested) {
        const choice = await this._ownerSelector.chooseOwner({
          ticketNumber,
          candidates: remaining.map(({ key, name }) => ({ key, name })),
          signal: this._ownerSelectionAbort?.signal,
        });
        if (choice.status !== 'selected') {
          return { status: 'manual', reason: choice.status };
        }
        if (this._stopRequested) {
          return { status: 'manual', reason: 'cancelled' };
        }
        const candidate = remaining.find(item => item.key === choice.candidateKey);
        if (!candidate) return { status: 'manual', reason: 'error' };
        const result = await this._ownerBrowser.apply(this.page, candidate);
        if (result.status === 'assigned') break;
        remaining = remaining.filter(item => item.key !== candidate.key);
        await this._notify(`⚠️ ${candidate.name} אינו זכאי לכרטיס הזה. בחר בעלים אחר.`);
      }

      if (remaining.length === 0) {
        return { status: 'manual', reason: 'no-eligible-owner' };
      }
      ticketNumber++;
    }
    return { status: 'manual', reason: 'cancelled' };
  }

  async _finishCartOwnerFlow() {
    let result;
    try {
      result = await this._completeOwnerAssignments();
    } catch (_) {
      this.log('Owner assignment failed', 'error');
      result = { status: 'manual', reason: 'error' };
    }

    const messages = {
      complete: '✅ כל הכרטיסים שויכו. הסל מוכן לתשלום.',
      timeout: '⚠️ זמן הבחירה הסתיים. יש להשלים את השיוך ידנית בסל.',
      cancelled: '⚠️ בחירת הבעלים בוטלה. יש להשלים את השיוך ידנית בסל.',
      'no-eligible-owner': '⚠️ אף אחד מהאנשים שנבחרו אינו זכאי. יש להשלים ידנית.',
      error: '⚠️ לא ניתן להשלים את השיוך אוטומטית. יש להשלים ידנית בסל.',
    };
    const message = result.status === 'complete'
      ? messages.complete
      : (messages[result.reason] || messages.error);
    if (!this._stopRequested) this._setPhase('cart-ready');
    await this._sendCartRecovery(message, { verifiedCart: true });
    return result;
  }

  async _sendCartRecovery(message, { verifiedCart = false } = {}) {
    const notificationOptions = verifiedCart
      ? { checkoutReady: true }
      : { inspectCart: true };
    const dashboardText = buildNotificationText(this.settings, message, notificationOptions);
    const delivered = await this._notify(message, notificationOptions);
    if (!delivered) this._emitDashboardFallback(dashboardText);
    return delivered;
  }

  _emitDashboardFallback(notificationText) {
    this.log(notificationText, 'warning');
    this.emit('alert', notificationText);
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  async _notify(message, options = {}) {
    const s = this.settings;
    const notificationText = buildNotificationText(s, message, options);
    if (!s.telegramToken || !s.telegramChatId) return false;

    try {
      const res = await this._notificationFetch(`https://api.telegram.org/bot${s.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: s.telegramChatId,
          text: notificationText,
        }),
      });

      if (res.ok) {
        this.log('Telegram notification sent ✓', 'success');
        return true;
      } else {
        const data = await res.json();
        this.log('Telegram request failed code=TELEGRAM_API_FAILED.', 'error');
        return false;
      }
    } catch (e) {
      this.log('Telegram request failed code=TELEGRAM_SEND_FAILED.', 'error');
      return false;
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = Monitor;
module.exports.parseAvailableSections = parseAvailableSections;
module.exports.buildSectorsInfoUrl = buildSectorsInfoUrl;
module.exports.parseSectorsInfo = parseSectorsInfo;
module.exports.buildNotificationText = buildNotificationText;
