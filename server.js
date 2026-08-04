// server.js — Express + WebSocket server

require('dotenv').config();

const express = require('express');
const http    = require('http');
const https   = require('https');
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');
const Monitor = require('./monitor');
const { SettingsStore, SettingsValidationError } = require('./settings-store');

const app    = express();
const server = http.createServer(app);
// isAuthed is defined below (needs SESSION_SECRET etc.) but only invoked per-connection,
// well after the whole module has finished loading.
const wss    = new WebSocket.Server({ server, verifyClient: (info, cb) => cb(isAuthed(info.req)) });

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

// ── Middleware ────────────────────────────────────────────────────────────

app.use(express.json());

// Routes reachable without a session — must come before the auth gate.
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

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
  if (!monitor.running) {
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
    await monitor.start(settings);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// ── WebSocket — only authenticated sessions may connect ────────────────────

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'status',   status: monitor.getStatus() }));
  // If monitor is running, show live section statuses; otherwise show configured sections as pending
  const liveSections = monitor.getSections();
  const sections = monitor.running || Object.keys(liveSections).length > 0
    ? liveSections
    : Object.fromEntries(loadSettings().sections.map(s => [s, { status: 'pending' }]));
  ws.send(JSON.stringify({ type: 'sections', sections }));
  ws.send(JSON.stringify({ type: 'stats',    stats:    monitor.getStats()    }));
});

// ── Start ─────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🎟️  MHFC Ticket Monitor`);
  console.log(`   Running at http://localhost:${PORT}\n`);
});

module.exports = { server, PORT };
