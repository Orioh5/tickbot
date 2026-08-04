// app.js — Frontend dashboard logic

// ── Stadium zones ─────────────────────────────────────────────────────────────

const STADIUM_ZONES = {
  'Upper Avi Ran': [201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212],
  'Gold':  [401, 402, 403, 404, 405, 406, 407, 408, 409, 410,],
  'Upper East':  [218, 219, 220, 221, 222],
  'Silver':  [301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311,312],
  'Lower Avi Ran': [101, 102, 103, 104 , 105, 106, 107, 108, 109],
  'Lower East':  [114, 115, 116, 117, 118],
  'South Lower': [123, 124,125,126,127,128],
  'South Upper': [228,229,230,231,232,233,234],
  'North Family':[110,111,112,113,213,214,215,216,217],
  'South Family':[119,120,121,122,223,224,225,226,227]
};

const ALL_SECTION_NUMS = Object.values(STADIUM_ZONES).flat().map(String);

let selectedSections = new Set();

function renderSectionPicker() {
  const picker = $('sectionPicker');
  picker.innerHTML = Object.entries(STADIUM_ZONES).map(([zone, sections]) => `
    <div class="zone-group">
      <div class="zone-header">
        <span class="zone-name">${zone}</span>
        <button type="button" class="zone-select-btn" data-zone="${zone}">Select zone</button>
      </div>
      <div class="zone-sections">
        ${sections.map(s => `
          <button type="button" class="sec-toggle${selectedSections.has(String(s)) ? ' selected' : ''}" data-section="${s}">${s}</button>
        `).join('')}
      </div>
    </div>
  `).join('');

  updateSelectedCount();

  picker.querySelectorAll('.sec-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const sec = btn.dataset.section;
      if (selectedSections.has(sec)) {
        selectedSections.delete(sec);
        btn.classList.remove('selected');
      } else {
        selectedSections.add(sec);
        btn.classList.add('selected');
      }
      updateSelectedCount();
    });
  });

  picker.querySelectorAll('.zone-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const zoneSecs = STADIUM_ZONES[btn.dataset.zone].map(String);
      const allSelected = zoneSecs.every(s => selectedSections.has(s));
      zoneSecs.forEach(s => allSelected ? selectedSections.delete(s) : selectedSections.add(s));
      renderSectionPicker();
    });
  });
}

function updateSelectedCount() {
  const hint = $('selectedCountHint');
  if (hint) hint.textContent = `${selectedSections.size} section${selectedSections.size !== 1 ? 's' : ''} selected`;
}

// ─────────────────────────────────────────────────────────────────────────────

const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsScheme}//${location.host}`);

let startedAt      = null;
let uptimeInterval = null;
let autoScroll     = true;
let isRunning      = false;

// ── DOM refs ────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const ui = {
  statusBadge:      $('statusBadge'),
  startBtn:         $('startBtn'),
  stopBtn:          $('stopBtn'),
  settingsBtn:      $('settingsBtn'),
  closeSettingsBtn: $('closeSettingsBtn'),
  overlayBackdrop:  $('overlayBackdrop'),
  settingsOverlay:  $('settingsOverlay'),
  saveSettingsBtn:  $('saveSettingsBtn'),
  testTelegramBtn:  $('testTelegramBtn'),
  sectionsGrid:     $('sectionsGrid'),
  sectionSummary:   $('sectionSummary'),
  logFeed:          $('logFeed'),
  clearLogBtn:      $('clearLogBtn'),
  scrollPaused:     $('scrollPausedBanner'),
  resumeScrollBtn:  $('resumeScrollBtn'),
  statsChecks:      $('statsChecks'),
  statsAlerts:      $('statsAlerts'),
  statsErrors:      $('statsErrors'),
  statsUptime:      $('statsUptime'),
  alertToast:       $('alertToast'),
};

// ── WebSocket ───────────────────────────────────────────────────────────────

ws.onmessage = event => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'status':   handleStatus(msg.status);           break;
    case 'sections': renderSections(msg.sections);       break;
    case 'stats':    updateStats(msg.stats);             break;
    case 'log':      addLog(msg.message, msg.level, msg.timestamp); break;
    case 'alert':    showToast(msg.message);             break;
  }
};

ws.onopen  = ()  => addLog('Connected to monitor server.', 'success');
ws.onclose = ()  => addLog('Connection lost. Please refresh the page.', 'error');
ws.onerror = err => addLog('WebSocket error — is the server running?', 'error');

// ── Status ───────────────────────────────────────────────────────────────────

function handleStatus(status) {
  const running = status.running;
  const busy = status.busy ?? running;
  const phaseLabels = {
    starting: '● STARTING',
    monitoring: '● MONITORING',
    'cart-interaction': '● ADDING TO CART',
    'cart-verification': '● VERIFYING CART',
    'cart-recovery': '● CHECK CART MANUALLY',
    'owner-selection': '● OWNER SELECTION',
    'cart-ready': '● CART READY',
    stopping: '● STOPPING',
  };
  isRunning = busy;

  ui.statusBadge.className = `badge ${busy ? 'badge-running' : 'badge-stopped'}`;
  ui.statusBadge.textContent = busy ? (phaseLabels[status.phase] || '● ACTIVE') : '● STOPPED';

  ui.startBtn.disabled = busy;
  ui.stopBtn.disabled  = !busy;

  if (busy && status.startedAt) {
    startedAt = new Date(status.startedAt);
    if (!uptimeInterval) uptimeInterval = setInterval(tickUptime, 1000);
  } else {
    startedAt = null;
    clearInterval(uptimeInterval);
    uptimeInterval = null;
    ui.statsUptime.textContent = '--';
  }
}

function tickUptime() {
  if (!startedAt) return;
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  ui.statsUptime.textContent = h > 0
    ? `${h}h ${m}m`
    : m > 0
    ? `${m}m ${sec}s`
    : `${sec}s`;
}

async function refreshMonitorStatus() {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error(`Status request failed (${res.status})`);
  const snapshot = await res.json();
  handleStatus(snapshot.status);
  if (snapshot.sections) renderSections(snapshot.sections);
  if (snapshot.stats) updateStats(snapshot.stats);
  return snapshot.status;
}

// ── Stats ────────────────────────────────────────────────────────────────────

function updateStats(stats) {
  ui.statsChecks.textContent = stats.checks;
  ui.statsAlerts.textContent = stats.alerts;
  ui.statsErrors.textContent = stats.errors;
  ui.statsErrors.style.color = stats.errors > 0 ? 'var(--red)' : '';
}

// ── Sections ─────────────────────────────────────────────────────────────────

const STATUS_LABEL = {
  pending:     'Pending',
  checking:    'Checking…',
  available:   'Available!',
  unavailable: 'Sold Out',
  not_found:   'Unknown',
  error:       'Error',
};

function renderSections(sections) {
  const entries = Object.entries(sections);

  ui.sectionsGrid.innerHTML = entries.map(([num, data]) => `
    <div class="section-card status-${data.status}" data-section="${num}" title="Section ${num}: ${STATUS_LABEL[data.status] || data.status}">
      <span class="section-num">${num}</span>
      <span class="section-status">${STATUS_LABEL[data.status] || data.status}</span>
    </div>
  `).join('');

  // Click available section → open ticket page
  ui.sectionsGrid.querySelectorAll('.section-card.status-available').forEach(card => {
    card.addEventListener('click', () => {
      const url = document.getElementById('cfgUrl').value.trim();
      if (url) window.open(url, '_blank');
    });
  });

  // Summary
  const available = entries.filter(([, v]) => v.status === 'available').length;
  const checking  = entries.filter(([, v]) => v.status === 'checking').length;
  if (available > 0) {
    ui.sectionSummary.innerHTML = `<span style="color:var(--green);font-weight:700;">🎟 ${available} available!</span>`;
  } else if (checking > 0) {
    ui.sectionSummary.textContent = 'Checking…';
  } else {
    ui.sectionSummary.textContent = `${entries.length} sections`;
  }
}

// ── Log ──────────────────────────────────────────────────────────────────────

function addLog(message, level = 'info', timestamp) {
  const time    = timestamp ? new Date(timestamp) : new Date();
  const timeStr = time.toLocaleTimeString('en-GB', { hour12: false });

  const entry = document.createElement('div');
  entry.className = `log-entry level-${level}`;
  entry.innerHTML = `
    <span class="log-time">${timeStr}</span>
    <span class="log-msg">${escapeHtml(message)}</span>
  `;

  ui.logFeed.appendChild(entry);
  if (autoScroll) ui.logFeed.scrollTop = ui.logFeed.scrollHeight;

  // Keep at most 600 entries
  while (ui.logFeed.children.length > 600) ui.logFeed.removeChild(ui.logFeed.firstChild);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Toast ────────────────────────────────────────────────────────────────────

let toastTimer;
function showToast(message) {
  ui.alertToast.textContent = message;
  ui.alertToast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.alertToast.classList.add('hidden'), 12000);
}

// ── Settings form ─────────────────────────────────────────────────────────────

async function loadSettings() {
  const res  = await fetch('/api/settings');
  const data = await res.json();
  fillForm(data);
  return data;
}

function fillForm(s) {
  $('cfgUrl').value            = s.url            || '';
  $('cfgCustomSections').value = s.customSections || '';
  selectedSections = new Set((s.sections || []).map(String));
  renderSectionPicker();
  $('cfgInterval').value       = Math.round((s.intervalMs || 10000) / 1000);
  $('cfgPauseOnHit').checked   = s.pauseOnHit !== false;
  $('cfgHeadful').checked      = !!s.headful;
  $('cfgDesiredQuantity').value = s.desiredQuantity || 1;
  // Secrets are never sent to the browser — leave blank and hint whether one's saved.
  $('cfgTelegramToken').value       = '';
  $('cfgTelegramToken').placeholder = s.telegramTokenSet ? '(already set — leave blank to keep)' : 'Bot Token';
  $('cfgTelegramChatId').value      = s.telegramChatId || '';
  $('cfgUsername').value            = s.loginUsername  || '';
  $('cfgPassword').value            = '';
  $('cfgPassword').placeholder      = s.loginPasswordSet ? '(already set — leave blank to keep)' : '••••••••';
  // loginUrl is constant — no UI field
}

function readForm() {
  const custom = $('cfgCustomSections').value.trim();
  const sections = custom
    ? custom.split(',').map(s => s.trim()).filter(Boolean)
    : Array.from(selectedSections);
  const out = {
    url:            $('cfgUrl').value.trim(),
    customSections: custom,
    sections,
    intervalMs:     parseInt($('cfgInterval').value, 10) * 1000,
    pauseOnHit:     $('cfgPauseOnHit').checked,
    headful:        $('cfgHeadful').checked,
    telegramChatId: $('cfgTelegramChatId').value.trim(),
    loginUsername:  $('cfgUsername').value.trim(),
    loginUrl:       'https://auth.mhaifafc.com/',
    desiredQuantity: parseInt($('cfgDesiredQuantity').value, 10) || 1,
  };
  // Secret fields: only include if the user actually typed a new value — otherwise
  // the server keeps whatever's already saved.
  const token    = $('cfgTelegramToken').value.trim();
  const password = $('cfgPassword').value;
  if (token) out.telegramToken = token;
  if (password) out.loginPassword = password;
  return out;
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Start
ui.startBtn.addEventListener('click', async () => {
  ui.startBtn.disabled = true;
  ui.startBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></circle></svg> Starting…';
  try {
    const res  = await fetch('/api/monitor/start', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      addLog(`Failed to start: ${data.error || `HTTP ${res.status}`}`, 'error');
      if (res.status === 409) {
        try {
          await refreshMonitorStatus();
        } catch (statusError) {
          addLog(`Could not refresh monitor status: ${statusError.message}`, 'error');
          ui.startBtn.disabled = true;
          ui.stopBtn.disabled = false;
        }
      } else {
        ui.startBtn.disabled = isRunning;
      }
    }
  } catch (e) {
    addLog(`Failed to start: ${e.message}`, 'error');
    ui.startBtn.disabled = isRunning;
  }
  ui.startBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Monitoring';
});

// Stop
ui.stopBtn.addEventListener('click', () => fetch('/api/monitor/stop', { method: 'POST' }));

// Settings open/close
ui.settingsBtn.addEventListener('click', () => ui.settingsOverlay.classList.remove('hidden'));
ui.closeSettingsBtn.addEventListener('click', () => ui.settingsOverlay.classList.add('hidden'));
ui.overlayBackdrop.addEventListener('click', () => ui.settingsOverlay.classList.add('hidden'));

// Escape key closes settings
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') ui.settingsOverlay.classList.add('hidden');
});

// Save settings
ui.saveSettingsBtn.addEventListener('click', async () => {
  ui.saveSettingsBtn.textContent = 'Saving…';
  ui.saveSettingsBtn.disabled = true;

  const formData = readForm();

  const res = await fetch('/api/settings', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(formData),
  });

  if (res.ok) {
    // Update the sections grid immediately with the new selection
    if (!isRunning) {
      const pending = Object.fromEntries(formData.sections.map(s => [s, { status: 'pending' }]));
      renderSections(pending);
    }
    addLog('Settings saved.', 'success');
    ui.settingsOverlay.classList.add('hidden');
  } else {
    addLog('Failed to save settings.', 'error');
  }

  ui.saveSettingsBtn.textContent = 'Save Settings';
  ui.saveSettingsBtn.disabled = false;
});

// Test Telegram — runs server-side against the saved token, so the bot token
// never needs to be typed into or held by the browser to test it.
ui.testTelegramBtn.addEventListener('click', async () => {
  ui.testTelegramBtn.textContent = 'Sending…';
  ui.testTelegramBtn.disabled    = true;

  try {
    const res  = await fetch('/api/telegram/test', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      addLog('Telegram test sent successfully! Check your Telegram.', 'success');
    } else {
      addLog(`Telegram error: ${data.error}`, 'error');
    }
  } catch (e) {
    addLog(`Telegram test failed: ${e.message}`, 'error');
  }

  ui.testTelegramBtn.textContent = 'Send Test Message';
  ui.testTelegramBtn.disabled    = false;
});

// Section picker controls
$('pickAll').addEventListener('click', () => {
  ALL_SECTION_NUMS.forEach(s => selectedSections.add(s));
  renderSectionPicker();
});
$('pickNone').addEventListener('click', () => {
  selectedSections.clear();
  renderSectionPicker();
});

// Clear log
ui.clearLogBtn.addEventListener('click', () => { ui.logFeed.innerHTML = ''; });

// Auto-scroll — pause when user scrolls up
ui.logFeed.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = ui.logFeed;
  const atBottom = scrollHeight - scrollTop - clientHeight < 60;
  autoScroll = atBottom;
  ui.scrollPaused.classList.toggle('hidden', atBottom);
});

ui.resumeScrollBtn.addEventListener('click', () => {
  autoScroll = true;
  ui.logFeed.scrollTop = ui.logFeed.scrollHeight;
  ui.scrollPaused.classList.add('hidden');
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadSettings();
