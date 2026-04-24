// monitor.js — Playwright monitoring logic

const EventEmitter = require('events');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STATE_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'state.json')
  : path.join(__dirname, 'state.json');

class Monitor extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.sections = {};
    this.stats = { checks: 0, alerts: 0, errors: 0, startedAt: null, lastCheck: null };
    this.settings = null;
    this._stopRequested = false;
  }

  log(message, level = 'info') {
    console.log(`[${level.toUpperCase()}] ${message}`);
    this.emit('log', message, level);
  }

  getStatus() {
    return { running: this.running, startedAt: this.stats.startedAt, lastCheck: this.stats.lastCheck };
  }

  getSections() {
    return { ...this.sections };
  }

  getStats() {
    return { ...this.stats };
  }

  async start(settings) {
    if (this.running) {
      this.log('Monitor is already running', 'warning');
      return;
    }

    this._stopRequested = false;
    this.settings = settings;

    // Init section states
    this.sections = {};
    for (const s of settings.sections) {
      this.sections[s] = { status: 'pending' };
    }

    this.stats = { checks: 0, alerts: 0, errors: 0, startedAt: new Date().toISOString(), lastCheck: null };
    this.running = true;

    this.emit('status', this.getStatus());
    this.emit('sections', this.getSections());
    this.emit('stats', this.getStats());

    this.log('Initializing browser...', 'info');

    try {
      await this._launch();
      this.log('Browser ready. Starting monitoring loop...', 'success');
      this._runLoop(); // intentionally not awaited
    } catch (e) {
      this.log(`Failed to start browser: ${e.message}`, 'error');
      this.running = false;
      this.emit('status', this.getStatus());
    }
  }

  async stop() {
    if (!this.running) return;
    this._stopRequested = true;
    this.running = false;

    if (this.browser) {
      try { await this.browser.close(); } catch (_) {}
      this.browser = null;
      this.context = null;
      this.page = null;
    }

    this.log('Monitor stopped.', 'info');
    this.emit('status', this.getStatus());
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

    this.browser = await pw.chromium.launch(launchOpts);

    const ctxOpts = {
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'he-IL',
    };

    if (fs.existsSync(STATE_PATH)) {
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

    // Intercept API responses for availability data
    this.page.on('response', async response => {
      const url = response.url();
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
      this.log(`Login failed: ${e.message}. Continuing with existing session.`, 'warning');
    }
  }

  // ── Main loop ─────────────────────────────────────────────────────────────

  async _runLoop() {
    let consecutiveErrors = 0;
    let navigated = false;

    while (this.running && !this._stopRequested) {
      try {
        if (!navigated) {
          this.log('Loading event page...', 'info');
          await this.page.goto(this.settings.url, { waitUntil: 'networkidle', timeout: 45000 });
          await this._sleep(2000);
          navigated = true;
        }

        await this._checkAvailability();
        consecutiveErrors = 0;

      } catch (e) {
        if (!this.running) break;
        consecutiveErrors++;
        this.stats.errors++;
        this.emit('stats', this.getStats());
        this.log(`Error (${consecutiveErrors}/3): ${e.message}`, 'error');

        if (consecutiveErrors >= 3) {
          this.log('Too many errors — waiting 60s before retry...', 'warning');
          for (let i = 0; i < 60 && this.running; i++) await this._sleep(1000);
          consecutiveErrors = 0;
          navigated = false;
        }
      }

      if (this.running) await this._sleep(this.settings.intervalMs);
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
      this.log('Queue-it detected! You are in a queue.', 'warning');
      await this._notify('⚠️ Queue-it detected — you\'re in a queue!');
      return;
    }

    // Snapshot previous section statuses before this check cycle, so we can detect transitions
    const prevSections = { ...this.sections };

    // Mark all as checking
    for (const s of this.settings.sections) {
      this.sections[s] = { status: 'checking' };
    }
    this.emit('sections', this.getSections());

    // Read available sections from the page — sections appear in the LI list only when available
    // Extract BOTH the onclick internal ID and the visual block label from text content.
    // The ticketing site uses large internal IDs (e.g. 1590) in onclick but shows small visual
    // numbers (e.g. 13) on the map and in the element text ("גוש 13"). Users type visual numbers,
    // so we compare against labels; onclick IDs are kept as a fallback for advanced users.
    const availableOnPage = await this.page.evaluate(() => {
      return Array.from(document.querySelectorAll('[onclick*="processSectorById"]'))
        .map(el => {
          const m = (el.getAttribute('onclick') || '').match(/processSectorById\((\d+)\)/);
          if (!m) return null;
          // Extract the visual block number from text content (e.g. "גוש 13" → "13")
          const labelMatch = el.textContent.trim().match(/(\d+)/);
          return { id: m[1], label: labelMatch ? labelMatch[1] : m[1] };
        })
        .filter(Boolean);
    }).catch(() => []);

    const onPageSummary = availableOnPage.length
      ? availableOnPage.map(s => s.label !== s.id ? `${s.label} (id:${s.id})` : s.id).join(', ')
      : 'none';
    this.log(`Sections on page: [${onPageSummary}]`, 'info');

    const availableLabels = new Set(availableOnPage.map(s => s.label));
    const availableIds    = new Set(availableOnPage.map(s => s.id));

    for (const section of this.settings.sections) {
      const sec = String(section);
      this.sections[section] = {
        status: (availableLabels.has(sec) || availableIds.has(sec)) ? 'available' : 'unavailable'
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
      let purchased = false;
      if (this.settings.autoPurchase) {
        purchased = await this._tryAutoPurchase(newlyAvailable[0]);
      }

      this.stats.alerts++;
      this.emit('stats', this.getStats());
      const msg = purchased
        ? `🛒 Tickets added to cart! Section ${newlyAvailable[0]} — complete checkout now!`
        : `🎟️ Tickets available in sections: ${newlyAvailable.join(', ')}!`;
      this.log(msg, 'alert');
      this.emit('alert', msg);
      await this._notify(msg);

      if (this.settings.pauseOnHit) {
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
    if (!this.page) return false;
    try {
      this.log(`Auto-purchase: clicking section ${sectionId}...`, 'info');

      // Click the section element
      const el = await this.page.$(`[onclick*="processSectorById(${sectionId})"]`);
      if (!el) {
        this.log('Auto-purchase: section element not found on page', 'warning');
        return false;
      }
      await el.click();

      // Wait for the quantity dialog
      await this.page.waitForSelector(
        '.modal, [class*="dialog"], [class*="popup"], [class*="modal"]',
        { timeout: 6000 }
      );
      await this._sleep(500);

      // Increase quantity if desired > 1
      const target = Math.max(1, this.settings.desiredQuantity || 1);
      for (let i = 1; i < target; i++) {
        await this.page.click(
          'button:has-text("+"), [class*="plus"], [class*="increment"], [aria-label*="increase"]'
        ).catch(() => {});
        await this._sleep(300);
      }

      // Confirm the dialog
      await this.page.click(
        'button:has-text("OK"), button:has-text("אישור"), button:has-text("✓"), [class*="confirm"], [class*="ok-btn"]'
      );

      this.log(`Auto-purchase: section ${sectionId} added to cart!`, 'success');
      return true;
    } catch (e) {
      this.log(`Auto-purchase failed: ${e.message}`, 'error');
      return false;
    }
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  async _notify(message) {
    const s = this.settings;
    if (!s.telegramToken || !s.telegramChatId) return;

    try {
      const res = await fetch(`https://api.telegram.org/bot${s.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: s.telegramChatId,
          text: `${message}\n\n🔑 Login & go straight there:\n${s.loginUrl}?redirectUrl=${encodeURIComponent(s.url)}\n\n🎟️ Direct link (if already logged in):\n${s.url}`,
        }),
      });

      if (res.ok) {
        this.log('Telegram notification sent ✓', 'success');
      } else {
        const data = await res.json();
        this.log(`Telegram error: ${data.description || res.statusText}`, 'error');
      }
    } catch (e) {
      this.log(`Telegram failed: ${e.message}`, 'error');
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = Monitor;
