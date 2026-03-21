// server.js — Express + WebSocket server

require('dotenv').config();

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const fs   = require('fs');
const path = require('path');
const Monitor = require('./monitor');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const PORT = process.env.PORT || 3000;

// ── Settings ──────────────────────────────────────────────────────────────

function defaultSettings() {
  return {
    url:            'https://tickets.mhaifafc.com/Stadium/Index?eventId=5230',
    sections:       ['201','202','203','204','205','206','207','208','209','210','211','212'],
    intervalMs:     10000,
    pauseOnHit:     true,
    telegramToken:  process.env.TELEGRAM_TOKEN  || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    loginUsername:  process.env.LOGIN_USERNAME   || '',
    loginPassword:  process.env.LOGIN_PASSWORD   || '',
    loginUrl:       'https://auth.mhaifafc.com/',
    headful:        false,
    proxyServer:    '',
    proxyUsername:  '',
    proxyPassword:  '',
  };
}

function loadSettings() {
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      return { ...defaultSettings(), ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) };
    } catch (_) {}
  }
  return defaultSettings();
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
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
app.use(express.static(path.join(__dirname, 'public')));

// ── REST API ──────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  res.json(loadSettings());
});

app.post('/api/settings', (req, res) => {
  const settings = { ...loadSettings(), ...req.body };
  saveSettings(settings);
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

// ── WebSocket — send current state on connect ──────────────────────────────

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'status',   status:   monitor.getStatus()   }));
  ws.send(JSON.stringify({ type: 'sections', sections: monitor.getSections() }));
  ws.send(JSON.stringify({ type: 'stats',    stats:    monitor.getStats()    }));
});

// ── Start ─────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🎟️  MHFC Ticket Monitor`);
  console.log(`   Running at http://localhost:${PORT}\n`);
});
