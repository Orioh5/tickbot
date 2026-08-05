'use strict';

const button = (text, callback_data) => ({ text, callback_data });

const ACTIVE_PHASES = new Set([
  'starting',
  'monitoring',
  'cart-interaction',
  'cart-verification',
  'owner-selection',
  'cart-ready',
  'cart-recovery',
  'session-expired',
]);

function normalizeLifecycle(status) {
  if (!status) return 'idle';
  const phase = String(status.phase ?? status.status ?? '').toLowerCase();
  if (phase === 'idle') return 'idle';
  if (phase === 'queued') return 'queued';
  if (phase === 'stopping') return 'stopping';
  if (phase === 'stopped' && !status.running && !status.busy) return 'idle';
  if (ACTIVE_PHASES.has(phase) || status.running || status.busy) return 'active';
  // Unknown runtime phases fail closed. A non-empty coordinator status means a
  // resource or transition still exists, so stale setup actions stay disabled.
  return phase ? 'active' : 'idle';
}

function snapshot(state = {}) {
  if (state.lifecycle && state.monitorStatus !== undefined) return state;
  const monitorStatus = state.monitorStatus ?? (state.monitorPhase
    ? { phase: state.monitorPhase, busy: state.monitorPhase !== 'stopped' }
    : null);
  return Object.freeze({
    isRegistered: Boolean(state.isRegistered),
    isRevoked: Boolean(state.isRevoked),
    isAdmin: Boolean(state.isAdmin),
    hasSession: Boolean(state.hasSession),
    monitorStatus,
    lifecycle: normalizeLifecycle(monitorStatus),
  });
}

function allowedActions(state) {
  const current = snapshot(state);
  const actions = new Set();
  if (!current.isRegistered || current.isRevoked) return actions;

  if (current.lifecycle === 'queued') {
    actions.add('status');
    actions.add('stop');
  } else if (current.lifecycle === 'stopping') {
    actions.add('status');
  } else if (current.lifecycle === 'active') {
    actions.add('status');
    actions.add('stop');
    actions.add('change');
  } else if (!current.hasSession) {
    actions.add('login');
  } else {
    actions.add('games');
    actions.add('status');
  }
  actions.add('home');
  if (current.isAdmin) {
    actions.add('invite');
    actions.add('users');
  }
  return actions;
}

function main(state) {
  const current = snapshot(state);
  if (!current.isRegistered || current.isRevoked) {
    return {
      text: 'אין הרשאה. יש להיכנס דרך קישור הזמנה תקין.',
      reply_markup: { inline_keyboard: [] },
    };
  }

  const actions = allowedActions(current);
  const rows = [];
  if (actions.has('login')) rows.push([button('🔐 התחבר', 'menu:login')]);
  else if (current.lifecycle === 'active') {
    rows.push([button('📊 סטטוס', 'menu:status'), button('⏹ עצור', 'menu:stop')]);
    rows.push([button('⚙️ שנה בחירה', 'menu:change')]);
  } else if (current.lifecycle === 'queued') {
    rows.push([button('📊 סטטוס', 'menu:status'), button('⏹ בטל', 'menu:stop')]);
  } else if (current.lifecycle === 'stopping') {
    rows.push([button('📊 סטטוס', 'menu:status')]);
  } else {
    rows.push([button('⚽ בחר משחק', 'menu:games'), button('📊 סטטוס', 'menu:status')]);
  }

  if (current.isAdmin) {
    rows.push([button('➕ הזמן משתמש', 'admin:invite'), button('👥 משתמשים', 'admin:users')]);
  }

  return { text: 'מה תרצה לעשות?', reply_markup: { inline_keyboard: rows } };
}

module.exports = { main, snapshot, allowedActions, normalizeLifecycle };
