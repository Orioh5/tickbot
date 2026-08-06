// server.js — Express + WebSocket server

require('dotenv').config();

const express = require('express');
const http    = require('http');
const https   = require('https');
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');
const Monitor = require('./monitor');
const {
  SettingsStore,
  SettingsValidationError,
  validateMonitorPrerequisites,
} = require('./settings-store');

// Bot services — populated by bot/bot-server.js after this module is loaded.
// Kept as a mutable object so bot-server.js can assign into it without circular deps.
const botServices = {
  secureLoginService: null,
  userSessionStore: null,
  maccabiAuthenticator: null,
  loginNotifier: null,
};

let server = null;
let wss = null;

const SETTINGS_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'settings.json')
  : path.join(__dirname, 'settings.json');
const PORT = process.env.PORT || 3000;
const settingsStore = new SettingsStore({
  settingsPath: SETTINGS_PATH,
  encryptionSecret: process.env.ENCRYPTION_KEY,
});

// ── Auth ──────────────────────────────────────────────────────────────────
// ponytail: single shared login (one username/password for the whole site), not
// per-user accounts. This app monitors one Maccabi Haifa account for a small group
// of friends sharing one dashboard — add real user accounts if that ever changes.

const APP_USERNAME = process.env.APP_USERNAME || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
// ponytail: a random secret still signs sessions safely, it just invalidates all
// sessions on every restart. Set SESSION_SECRET in the hosting env to avoid that.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

if (!APP_PASSWORD) {
  console.warn('⚠️  APP_PASSWORD is not set — set it in your hosting env or anyone can log in with a blank password.');
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sign(value) {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
  return `${value}.${sig}`;
}

function verifySessionToken(token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const value = token.slice(0, i);
  const sig   = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(value) > Date.now();
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function isAuthed(req) {
  return verifySessionToken(parseCookies(req.headers.cookie).session);
}

function setSessionCookie(res) {
  const token = sign(String(Date.now() + SESSION_MAX_AGE_MS));
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}; SameSite=Lax${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}

// ── Settings ──────────────────────────────────────────────────────────────

function loadSettings() {
  return settingsStore.load();
}

// ── Broadcast ─────────────────────────────────────────────────────────────

function broadcast(data) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ── Monitor setup ─────────────────────────────────────────────────────────

const monitor = new Monitor();

monitor.on('log',      (message, level) => broadcast({ type: 'log', message, level, timestamp: new Date().toISOString() }));
monitor.on('status',   status           => broadcast({ type: 'status', status }));
monitor.on('sections', sections         => broadcast({ type: 'sections', sections }));
monitor.on('stats',    stats            => broadcast({ type: 'stats', stats }));
monitor.on('alert',    message          => broadcast({ type: 'alert', message }));

// ── Express app ───────────────────────────────────────────────────────────

function createApp({ botServices: injectedBotServices = botServices } = {}) {
  const app = express();

// ── Middleware ────────────────────────────────────────────────────────────

app.use(express.json());

// Routes reachable without a session — must come before the auth gate.
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// ── Bot login flow ─────────────────────────────────────────────────────────
// GET: show a login form (after validating the one-time token without consuming it).
// POST: consume the token, use Playwright to authenticate, save storageState.
// Credentials pass through a single async call — never persisted.

app.get('/bot-login', (req, res) => {
  const rawToken = String(req.query.t || '');
  if (!rawToken) return res.status(400).send('חוסר: קישור ללא טוקן.');
  const svc = injectedBotServices.secureLoginService;
  if (!svc) return res.status(503).send('Bot login not available.');
  try {
    svc.verifyToken(rawToken); // peek — does not consume
  } catch {
    return res.status(400).send('קישור ההתחברות אינו תקין או אינו זמין עוד. בקש קישור חדש מהבוט.');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><title>התחברות — מכבי חיפה</title>
<style>body{font-family:sans-serif;max-width:360px;margin:60px auto;padding:0 16px}
input{display:block;width:100%;margin:8px 0;padding:8px;box-sizing:border-box;font-size:16px}
button{width:100%;padding:12px;background:#005BAC;color:#fff;border:none;font-size:16px;cursor:pointer;margin-top:8px;border-radius:4px}
.note{font-size:12px;color:#666;margin-top:12px}</style></head>
<body>
<h2>התחבר לחשבון מכבי חיפה</h2>
<p>הזן את פרטי הגישה שלך. הם ישמשו להתחברות בלבד ולא יישמרו.</p>
<form method="POST" action="/bot-login">
  <input type="hidden" name="t" value="${rawToken.replace(/"/g, '&quot;')}">
  <label>שם משתמש<input type="text" name="username" autocomplete="username" required></label>
  <label>סיסמה<input type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">התחבר</button>
</form>
<p class="note">פרטיך לא נשמרים — הם משמשים רק להתחברות חד-פעמית. הקישור תקף ל-10 דקות.</p>
</body></html>`);
});

app.post('/bot-login', express.urlencoded({ extended: false }), async (req, res) => {
  const rawToken = String(req.body?.t || '');
  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');
  const svc = injectedBotServices.secureLoginService;
  const sessionStore = injectedBotServices.userSessionStore;
  const authenticator = injectedBotServices.maccabiAuthenticator;
  const loginNotifier = injectedBotServices.loginNotifier;
  if (!svc || !sessionStore || !authenticator || !loginNotifier) {
    return res.status(503).send('Bot login not available.');
  }
  let userId;
  try {
    userId = svc.verifyToken(rawToken); // keep valid so a failed login can be retried
  } catch {
    return res.status(400).send('קישור ההתחברות אינו תקין או אינו זמין עוד. בקש קישור חדש מהבוט.');
  }

  let storageState;
  try {
    storageState = await authenticator.login(username, password);
  } catch {
    console.error('[bot-login] Maccabi authentication failed.');
    return res.status(401).send('ההתחברות נכשלה. בדוק את הפרטים ונסה שוב באמצעות אותו קישור.');
  }

  let redeemedUserId;
  let sessionSaved = false;
  try {
    if (typeof svc.completeLogin === 'function') {
      redeemedUserId = svc.completeLogin(rawToken, authorizedUserId => {
        if (authorizedUserId !== userId) throw new Error('Login token user mismatch');
        try {
          sessionStore.save(authorizedUserId, storageState);
          sessionSaved = true;
        } catch (cause) {
          throw Object.assign(new Error('Session persistence failed'), {
            code: 'SESSION_PERSISTENCE_FAILED',
            cause,
          });
        }
      });
    } else {
      // Compatibility path for narrow test doubles and older integrations.
      // Production SecureLoginService uses completeLogin so authorization and
      // the synchronous encrypted file write share one SQLite write lock.
      redeemedUserId = svc.redeemToken(rawToken);
      if (redeemedUserId !== userId) throw new Error('Login token user mismatch');
    }
  } catch (error) {
    if (error?.code === 'SESSION_PERSISTENCE_FAILED') {
      console.error('[bot-login] Session persistence failed code=SESSION_PERSISTENCE_FAILED.');
      return res.status(500).send('לא ניתן היה לשמור את החיבור. בקש קישור חדש מהבוט ונסה שוב.');
    }
    console.error('[bot-login] Login token redemption failed.');
    return res.status(409).send('קישור ההתחברות אינו זמין עוד. בקש קישור חדש מהבוט.');
  }

  if (!sessionSaved) {
    try {
      await sessionStore.save(redeemedUserId, storageState);
    } catch {
      console.error('[bot-login] Session persistence failed code=SESSION_PERSISTENCE_FAILED.');
      return res.status(500).send('לא ניתן היה לשמור את החיבור. בקש קישור חדש מהבוט ונסה שוב.');
    }
  }

  await loginNotifier.loginSucceeded(redeemedUserId).catch(() => {
    console.error('[bot-login] Telegram notification failed.');
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send('<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>הצלחה</title></head>' +
    '<body><h2>✅ התחברת בהצלחה!</h2><p>חזור לבוט בטלגרם כדי להמשיך.</p></body></html>');
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const userOk = timingSafeEqualStr(username || '', APP_USERNAME);
  const passOk = APP_PASSWORD && timingSafeEqualStr(password || '', APP_PASSWORD);
  if (!userOk || !passOk) return res.status(401).json({ error: 'Invalid username or password' });
  setSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Everything below requires a valid session.
app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login.html');
});

app.use(express.static(path.join(__dirname, 'public')));

// ── REST API ──────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  res.json(settingsStore.toPublic());
});

app.post('/api/settings', (req, res) => {
  let settings;
  try {
    settings = settingsStore.update(req.body);
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error(`Failed to save settings: ${error.message}`);
    return res.status(500).json({ error: 'Failed to save settings' });
  }

  // If monitor isn't running, push the new section list to all dashboards immediately
  if (!monitor.getStatus().busy) {
    const pending = Object.fromEntries(settings.sections.map(s => [s, { status: 'pending' }]));
    broadcast({ type: 'sections', sections: pending });
  }
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({
    status:   monitor.getStatus(),
    sections: monitor.getSections(),
    stats:    monitor.getStats(),
  });
});

app.post('/api/monitor/start', async (req, res) => {
  const settings = loadSettings();
  try {
    validateMonitorPrerequisites(settings);
    await monitor.start(settings);
    res.json({ ok: true });
  } catch (error) {
    const status = error instanceof SettingsValidationError
      ? 400
      : (error.code === 'MONITOR_BUSY' ? 409 : 500);
    res.status(status).json({ error: error.message });
  }
});

app.post('/api/monitor/stop', async (req, res) => {
  await monitor.stop();
  res.json({ ok: true });
});

// Runs server-side so the Telegram bot token never has to round-trip through the browser.
app.post('/api/telegram/test', (req, res) => {
  const { telegramToken, telegramChatId } = loadSettings();
  if (!telegramToken || !telegramChatId) {
    return res.status(400).json({ error: 'Set and save a Telegram token and chat ID first.' });
  }
  const body = JSON.stringify({ chat_id: telegramChatId, text: '🧪 MHFC Monitor — test message. Bot is working!' });
  const request = https.request(
    `https://api.telegram.org/bot${telegramToken}/sendMessage`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    r => {
      let data = '';
      r.on('data', chunk => (data += chunk));
      r.on('end', () => {
        if (r.statusCode === 200) return res.json({ ok: true });
        res.status(502).json({ error: `Telegram API error: ${data}` });
      });
    }
  );
  request.on('error', e => res.status(502).json({ error: e.message }));
  request.write(body);
  request.end();
});

  return app;
}

// ── WebSocket — only authenticated sessions may connect ────────────────────

function attachWebSocketHandlers(webSocketServer) {
  webSocketServer.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'status',   status: monitor.getStatus() }));
    // If monitor is running, show live section statuses; otherwise show configured sections as pending
    const liveSections = monitor.getSections();
    const sections = monitor.running || Object.keys(liveSections).length > 0
      ? liveSections
      : Object.fromEntries(loadSettings().sections.map(s => [s, { status: 'pending' }]));
    ws.send(JSON.stringify({ type: 'sections', sections }));
    ws.send(JSON.stringify({ type: 'stats',    stats:    monitor.getStats()    }));
  });
}

// ── Start ─────────────────────────────────────────────────────────────────

function startServer() {
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY environment variable is required but not set.');
  }

  const app = createApp({ botServices });
  server = http.createServer(app);
  wss = new WebSocket.Server({
    server,
    verifyClient: (info, callback) => callback(isAuthed(info.req)),
  });
  attachWebSocketHandlers(wss);

  const host = process.env.HOST || '127.0.0.1';
  server.listen(PORT, host, () => {
    console.log(`\n🎟️  MHFC Ticket Monitor`);
    console.log(`   Running at http://${host}:${PORT}\n`);

    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const baseUrl  = process.env.BASE_URL || `${protocol}://localhost:${PORT}`;
    require('./bot/bot-server').start({ botServices, baseUrl });
  });

  return server;
}

if (require.main === module) {
  try {
    startServer();
  } catch (error) {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  createApp,
  startServer,
  PORT,
  botServices,
  get server() { return server; },
};
