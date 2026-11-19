/**
 * Daily summary — runs 08:00 Asia/Taipei
 * Sends a Telegram message with yesterday's spending + today's upcoming events
 */

function sendDailySummary() {
  // 兼容舊 trigger 名稱：實際走 notify* 模組
  try { notifyLedgerDaily(); } catch (err) { console.error('notifyLedgerDaily', err); }
  try { notifyBudgetWarn(); } catch (err) { console.error('notifyBudgetWarn', err); }
  try { notifyTripDaily(); } catch (err) { console.error('notifyTripDaily', err); }
  try { notifyTripCountdown(); } catch (err) { console.error('notifyTripCountdown', err); }
  return { ok: true };
}

function exportAllData() {
  // Returns a JSON bundle of all main collections
  var result = {
    exportedAt: new Date().toISOString(),
    collections: {},
  };
  ['stocks', 'fx_rates', 'transactions', 'categories', 'budgets', 'trips', 'flight_watches', 'alerts', 'portfolio', 'watchlist', 'recurring', 'ai_budget_configs', 'ai_usage_events']
    .forEach(function (c) {
      try {
        result.collections[c] = fsListAllDocs_(c, 500);
      } catch (err) {
        result.collections[c] = { error: String(err) };
      }
    });
  return result;
}
