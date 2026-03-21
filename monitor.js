// monitor.js — Playwright monitoring logic

const EventEmitter = require('events');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, 'state.json');

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

    // Block images, fonts, media for faster loading
    await this.context.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) {
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
          await this.page.goto(this.settings.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this._sleep(3000);
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

    // Mark all as checking
    for (const s of this.settings.sections) {
      this.sections[s] = { status: 'checking' };
    }
    this.emit('sections', this.getSections());

    // Check each section
    for (const section of this.settings.sections) {
      if (!this.running) break;
      this.sections[section] = { status: await this._checkSection(section) };
    }

    this.stats.checks++;
    this.stats.lastCheck = new Date().toISOString();
    this.emit('sections', this.getSections());
    this.emit('stats', this.getStats());

    const available = Object.entries(this.sections)
      .filter(([, v]) => v.status === 'available')
      .map(([k]) => k);

    if (available.length > 0) {
      this.stats.alerts++;
      this.emit('stats', this.getStats());
      const msg = `🎟️ Tickets available in sections: ${available.join(', ')}!`;
      this.log(msg, 'alert');
      this.emit('alert', msg);
      await this._notify(msg);

      if (this.settings.pauseOnHit) {
        this.log('Pausing — tickets found! Stop and restart to continue.', 'warning');
        this.running = false;
        this.emit('status', this.getStatus());
      }
    } else {
      this.log(`Check #${this.stats.checks}: No availability in ${this.settings.sections.length} sections`, 'info');
    }
  }

  async _checkSection(section) {
    try {
      return await this.page.evaluate(sectionNum => {
        const selectors = [
          `[data-section="${sectionNum}"]`,
          `[data-block="${sectionNum}"]`,
          `[data-id="${sectionNum}"]`,
          `[id="section_${sectionNum}"]`,
          `[id="block_${sectionNum}"]`,
          `[id="s${sectionNum}"]`,
          `[aria-label="${sectionNum}"]`,
          `[title="${sectionNum}"]`,
        ];

        let el = null;
        for (const sel of selectors) {
          el = document.querySelector(sel);
          if (el) break;
        }

        if (!el) return 'not_found';

        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return 'unavailable';

        const cls = ((el.className || '') + ' ' + (el.getAttribute('data-status') || '')).toLowerCase();

        if (cls.includes('disabled') || cls.includes('unavailable') ||
            cls.includes('sold') || cls.includes('locked') || cls.includes('full')) {
          return 'unavailable';
        }

        if (cls.includes('available') || cls.includes('open') || cls.includes('free')) {
          return 'available';
        }

        // SVG fill color heuristic — muted = unavailable
        const fill = (el.getAttribute('fill') || '').toLowerCase();
        if (fill && (fill.includes('#999') || fill.includes('#ccc') || fill.includes('#666') || fill === 'gray' || fill === 'grey')) {
          return 'unavailable';
        }

        return 'available';
      }, section);
    } catch (_) {
      return 'error';
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
          text: `${message}\n\n${s.url}`,
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
