'use strict';

// Wires all bot services together and attaches to the running HTTP server.
// Called from server.js after the Express app is ready.

const path = require('path');
const UserStore = require('./user-store');
const SecureLoginService = require('./secure-login-service');
const UserSessionStore = require('./user-session-store');
const GameDiscoveryService = require('./game-discovery');
const MonitorCoordinator = require('./monitor-coordinator');
const TelegramBotService = require('./telegram-bot-service');
const MaccabiAuthenticator = require('./maccabi-authenticator');

function start({ botServices, baseUrl, env = process.env }) {
  const token = env.BOT_TOKEN;
  if (!token) {
    console.warn('⚠️  BOT_TOKEN not set — Telegram bot is disabled.');
    return null;
  }

  const dataDir = env.DATA_DIR || path.join(path.dirname(__dirname), 'data');
  const dbPath  = path.join(dataDir, 'bot.db');
  const encKey  = env.ENCRYPTION_KEY; // already checked mandatory in server.js

  const userStore = new UserStore({ dbPath });

  const userSessionStore = new UserSessionStore({ dataDir, encryptionKey: encKey });

  const secureLoginService = new SecureLoginService({
    userStore,
    baseUrl,
  });
  const maccabiAuthenticator = new MaccabiAuthenticator();

  const { chromium } = require('playwright');
  const browserFactory = async (storageState) => {
    const browser = await chromium.launch({ headless: true });
    return browser;
  };

  const gameDiscovery = new GameDiscoveryService({ userSessionStore, browserFactory });

  const adminUserIds = (env.BOT_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

  // monitorCoordinator is created after bot so it can hold a reference to it
  let bot;
  const monitorCoordinator = new MonitorCoordinator({
    userStore,
    userSessionStore,
    gameDiscovery,
    telegramBotService: { // forward ref — real bot assigned below
      sendMessage: (...args) => bot?.sendMessage(...args),
      sendMarkdown: (...args) => bot?.sendMarkdown(...args),
      registerCallbackHandler: (...args) => bot?.registerCallbackHandler(...args),
      deregisterCallbackHandler: (...args) => bot?.deregisterCallbackHandler(...args),
    },
    maxConcurrent: parseInt(env.BOT_MAX_BROWSERS || '3', 10),
  });

  bot = new TelegramBotService({
    token,
    adminUserIds,
    userStore,
    secureLoginService,
    monitorCoordinator,
    userSessionStore,
  });

  // Expose to server.js for /bot-login endpoint
  botServices.secureLoginService = secureLoginService;
  botServices.userSessionStore   = userSessionStore;
  botServices.maccabiAuthenticator = maccabiAuthenticator;

  bot.start();
  void monitorCoordinator.restoreActiveMonitors().catch(error => {
    console.error('[MonitorCoordinator] restore failed:', error.message);
  });
  console.log('🤖  Telegram bot started');
  return bot;
}

module.exports = { start };
