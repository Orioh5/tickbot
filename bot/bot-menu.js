'use strict';

const button = (text, callback_data) => ({ text, callback_data });

function main(state) {
  if (!state.isRegistered || state.isRevoked) {
    return {
      text: 'אין הרשאה. יש להיכנס דרך קישור הזמנה תקין.',
      reply_markup: { inline_keyboard: [] },
    };
  }

  const rows = [];
  if (!state.hasSession) rows.push([button('🔐 התחבר', 'menu:login')]);
  else if (state.monitorPhase === 'monitoring') {
    rows.push([button('📊 סטטוס', 'menu:status'), button('⏹ עצור', 'menu:stop')]);
    rows.push([button('⚙️ שנה בחירה', 'menu:change')]);
  } else if (state.monitorPhase === 'queued') {
    rows.push([button('📊 סטטוס', 'menu:status'), button('⏹ בטל', 'menu:stop')]);
  } else {
    rows.push([button('⚽ בחר משחק', 'menu:games'), button('📊 סטטוס', 'menu:status')]);
  }

  if (state.isAdmin) {
    rows.push([button('➕ הזמן משתמש', 'admin:invite'), button('👥 משתמשים', 'admin:users')]);
  }

  return { text: 'מה תרצה לעשות?', reply_markup: { inline_keyboard: rows } };
}

module.exports = { main };
