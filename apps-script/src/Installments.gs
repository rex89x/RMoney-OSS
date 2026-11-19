/**
 * 信用卡分期付款（installment_plans）每期入帳。
 *
 * 前端 features/installments 建立計畫；這裡每天 01:00（tick_daily_0100，台北時間，pitfall #19）跑一次：
 * - 每期在「首期日 + (i − 1) 個月」（月底 clamp，pitfall #23）入帳一筆 expense，
 *   fromAccountId = 信用卡帳戶 → 卡片欠款增加（importAdjustAccount_，與 web / 匯入同一套規則）。
 * - 金額：perPeriodTWD；最後一期吸收尾差 = (totalAmountTWD + feeTWD) − perPeriodTWD × (N − 1)
 *   （與前端 features/installments/schedule.ts 同口徑，apps-script/tests/installments.test.cjs 有 parity 測試）。
 * - 冪等：tx id 固定為 `inst_{planId}_{i}`（i 從 1 起算）。已存在（含軟刪）就不再建立、也不再動餘額，
 *   只把 paidPeriods 補推進；所以上次 tx 寫成功但更新計畫失敗，這次不會重複入帳。
 * - 第一次跑會把所有已到期的期數一次補齊（catch up），之後每天只補當天到期的那期。
 * - status = 'cancelled' 不再入帳（已入帳的 tx 保留）；最後一期入帳後 status = 'completed'。
 */

var INSTALLMENT_TW_OFFSET_MS_ = 8 * 60 * 60 * 1000;

function runInstallmentPlans() {
  // 重 job 要上鎖（CLAUDE.md pitfall #11）：trigger 重疊或手動重跑會重複入帳
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { ok: false, error: 'could not acquire lock' };
  }
  try {
    return runInstallmentPlansLocked_(new Date());
  } finally {
    lock.releaseLock();
  }
}

function runInstallmentPlansLocked_(now) {
  var plans = fsListAllDocs_('installment_plans', 200);
  var summary = { ok: true, created: 0, completed: 0, plans: 0 };
  var createdItems = [];
  plans.forEach(function (plan) {
    try {
      var result = postInstallmentPlan_(plan, now);
      if (!result) return;
      summary.plans++;
      summary.created += result.created;
      if (result.completed) summary.completed++;
      createdItems = createdItems.concat(result.items);
    } catch (err) {
      console.error('[runInstallmentPlans]', plan && plan._name, err);
      try { notifyError('installments:' + ((plan && plan.title) || (plan && plan._name) || '?'), err); } catch (e) { console.error(e); }
    }
  });
  if (summary.created > 0) {
    try { notifyRecurringRun(summary.created, createdItems); } catch (err) { console.error('notifyRecurringRun (installments)', err); }
  }
  return summary;
}

/** 處理單一計畫；不需處理時回傳 null */
function postInstallmentPlan_(plan, now) {
  if (!plan || plan.status !== 'active') return null;
  var planId = String(plan._name || '').split('/').pop();
  if (!planId) return null;
  var planPath = 'installment_plans/' + planId;
  var periods = Math.max(1, Math.round(Number(plan.periods) || 0));
  var start = installmentToDate_(plan.startDate);
  if (!start || !plan.cardAccountId) return null;

  var paid = Math.max(0, Math.min(periods, Math.round(Number(plan.paidPeriods) || 0)));
  var startPaid = paid;
  var created = 0;
  var items = [];
  var account = null;
  var accountLoaded = false;

  for (var i = paid + 1; i <= periods; i++) {
    var due = installmentPeriodDate_(start, i);
    if (due.getTime() > now.getTime()) break;
    var txId = installmentTxId_(planId, i);
    if (!fsGetDoc_('transactions/' + txId)) {
      if (!accountLoaded) {
        account = fsGetDoc_('accounts/' + plan.cardAccountId);
        accountLoaded = true;
      }
      var amount = installmentPeriodAmount_(plan, i);
      var txData = {
        userId: plan.ownerId || '',
        type: 'expense',
        amount: amount,
        currency: 'TWD',
        amountTWD: amount,
        fxRate: 1,
        category: plan.category || 'other',
        paymentMethod: (account && (account.legacyPaymentMethod || account.name)) || '信用卡',
        fromAccountId: plan.cardAccountId,
        toAccountId: null,
        note: (plan.title || '分期') + ' ' + i + '/' + periods,
        tags: ['分期'],
        installmentPlanId: planId,
        installmentIndex: i,
        date: due,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      fsSetDoc_('transactions/' + txId, txData, false);
      // 支出讓卡片欠款變多（importAdjustAccount_ 對負債帳戶會反向處理正負號）
      importAdjustAccount_(plan.cardAccountId, 'TWD', -amount, -amount);
      created++;
      items.push({ title: txData.note, amountTWD: amount });
    }
    paid = i;
  }

  if (paid === startPaid) return { created: 0, completed: false, items: [] };
  var completed = paid >= periods;
  var patch = { paidPeriods: paid, lastPostedAt: now, updatedAt: now };
  if (completed) patch.status = 'completed';
  fsSetDoc_(planPath, patch, true);
  return { created: created, completed: completed, items: items };
}

function installmentTxId_(planId, index) {
  return 'inst_' + planId + '_' + index;
}

function installmentToDate_(value) {
  if (!value) return null;
  var d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 第 index 期（1 起算）的入帳日 = 首期日 + (index − 1) 個月，以台北日曆計算、月底 clamp。
 * 一律從首期日推算（不是上一期再加一個月），1/31 → 2/28 → 3/31。
 * 台北固定 UTC+8，用 +8h 後的 UTC 欄位運算，不受執行環境時區影響（與 web lib/tz.ts addTWCalendarMonths 相同）。
 */
function installmentPeriodDate_(start, index) {
  var wall = new Date(start.getTime() + INSTALLMENT_TW_OFFSET_MS_);
  var y = wall.getUTCFullYear();
  var m = wall.getUTCMonth() + (index - 1);
  var lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  var target = Date.UTC(
    y, m, Math.min(wall.getUTCDate(), lastDay),
    wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds(), wall.getUTCMilliseconds()
  );
  return new Date(target - INSTALLMENT_TW_OFFSET_MS_);
}

/** 第 index 期金額：最後一期吸收尾差 */
function installmentPeriodAmount_(plan, index) {
  var periods = Math.max(1, Math.round(Number(plan.periods) || 0));
  var total = Math.round(Number(plan.totalAmountTWD) || 0) + Math.round(Number(plan.feeTWD) || 0);
  var per = Number(plan.perPeriodTWD);
  if (!(per >= 0)) per = Math.floor(total / periods);
  if (index < periods) return per;
  return total - per * (periods - 1);
}

/** 尚未入帳（還沒進卡片餘額）的金額；只算 active 計畫。淨值負債端用（NetWorth.gs） */
function installmentRemainingTWD_(plan) {
  if (!plan || plan.status !== 'active') return 0;
  var periods = Math.max(1, Math.round(Number(plan.periods) || 0));
  var paid = Math.max(0, Math.min(periods, Math.round(Number(plan.paidPeriods) || 0)));
  var remaining = 0;
  for (var i = paid + 1; i <= periods; i++) remaining += installmentPeriodAmount_(plan, i);
  return remaining;
}
