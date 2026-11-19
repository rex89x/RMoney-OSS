/**
 * Recurring transaction generator
 * - Runs daily at 01:00 Asia/Taipei (via trigger)
 * - For each active recurring entry where nextDue <= now: create a tx and advance nextDue
 * - tx id = rec_{recurringId}_{yyyyMMdd}（冪等）；有 fromAccountId / toAccountId 就同步調整帳戶餘額
 *   （importAdjustAccount_，與 web / Telegram / 匯入同一套規則）；外幣用當天 fx_rates 重算 amountTWD
 */

function runRecurringTransactions() {
  // 重 job 要上鎖（CLAUDE.md #11）：trigger 重疊或手動重跑會重複入帳
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { ok: false, error: 'could not acquire lock' };
  }
  try {
    return runRecurringTransactionsLocked_();
  } finally {
    lock.releaseLock();
  }
}

function runRecurringTransactionsLocked_() {
  var now = new Date();
  var recs = fsListAllDocs_('recurring', 200);
  var created = 0;
  var createdItems = [];
  recs.forEach(function (r) {
    try {
      if (!r.active) return;
      var due = r.nextDue ? (r.nextDue instanceof Date ? r.nextDue : new Date(r.nextDue)) : null;
      if (!due || isNaN(due.getTime()) || due > now) return;

      var recurringId = (r._name || '').split('/').pop();
      var recPath = r._name.replace(/^.*documents\//, '');
      // 冪等鍵：同一個 recurring 同一個到期日只會有一筆 tx。
      // 上次若 tx 寫成功但推進 nextDue 失敗，這次只補推進、不重複入帳。
      var txId = 'rec_' + recurringId + '_' + Utilities.formatDate(due, 'Asia/Taipei', 'yyyyMMdd');
      if (fsGetDoc_('transactions/' + txId)) {
        fsSetDoc_(recPath, { nextDue: advanceDate_(due, r.frequency || 'monthly'), lastGeneratedAt: now }, true);
        return;
      }

      var tpl = r.template || {};
      var type = tpl.type || 'expense';
      var currency = tpl.currency || 'TWD';
      var amount = Number(tpl.amount) || 0;
      // 外幣：用入帳當天的匯率重算 amountTWD / fxRate，不再照範本複製舊匯率（pitfall #3）
      var fxRate = currency === 'TWD' ? 1 : (importFxRate_(currency) || Number(tpl.fxRate) || 1);
      var amountTWD = currency === 'TWD' ? amount : Math.round(amount * fxRate);
      var fromAccountId = (type === 'expense' || type === 'transfer') ? (tpl.fromAccountId || null) : null;
      var toAccountId = type === 'income' ? (tpl.toAccountId || tpl.fromAccountId || null)
        : type === 'transfer' ? (tpl.toAccountId || null) : null;

      var txData = Object.assign({}, tpl, {
        userId: r.userId,
        recurringId: recurringId,
        type: type,
        amount: amount,
        currency: currency,
        fxRate: fxRate,
        amountTWD: amountTWD,
        fromAccountId: fromAccountId,
        toAccountId: toAccountId,
        date: new Date(due),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      fsSetDoc_('transactions/' + txId, txData, false);

      // 帳戶餘額：與 web createTransaction / Telegram / 匯入一致（以前直寫 transactions 不動餘額，稽核 D1）
      if (type === 'expense' && fromAccountId) importAdjustAccount_(fromAccountId, currency, -amount, -amountTWD);
      if (type === 'income' && toAccountId) importAdjustAccount_(toAccountId, currency, amount, amountTWD);
      if (type === 'transfer') {
        if (fromAccountId) importAdjustAccount_(fromAccountId, currency, -amount, -amountTWD);
        if (toAccountId) importAdjustAccount_(toAccountId, currency, amount, amountTWD);
      }

      created++;
      createdItems.push(txData);

      // advance nextDue by frequency
      var nextDue = advanceDate_(due, r.frequency || 'monthly');
      fsSetDoc_(recPath, {
        nextDue: nextDue,
        lastGeneratedAt: now,
      }, true);
    } catch (err) {
      console.error('recurring gen failed', r._name, err);
      notifyError('recurring:' + ((r && r.label) || (r && r._name) || '?'), err);
    }
  });

  if (created > 0) {
    try { notifyRecurringRun(created, createdItems); } catch (err) { console.error('notifyRecurringRun', err); }
  }
  return { ok: true, created: created };
}

function advanceDate_(from, frequency) {
  var d = new Date(from);
  switch (frequency) {
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'biweekly': d.setDate(d.getDate() + 14); break;
    case 'yearly': d = addCalendarYears_(d, 1); break;
    case 'monthly':
    default:
      d = addCalendarMonths_(d, 1);
  }
  return d;
}

function addCalendarMonths_(from, months) {
  var d = new Date(from);
  var day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  var lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function addCalendarYears_(from, years) {
  var d = new Date(from);
  var day = d.getDate();
  d.setDate(1);
  d.setFullYear(d.getFullYear() + years);
  var lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}
