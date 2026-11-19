/**
 * Time-driven triggers management
 *
 * 手動執行 setupTriggers() 一次即可註冊所有定時任務。
 * 若要清除：deleteAllTriggers()。
 *
 * Trigger 表（共 12 個，完整說明見 docs/PERSONAL_HUB_SPEC.md §7.2；atHour(N) 只保證在 N 點那一小時內觸發）：
 *   tick_15min        — 每 15 min: 盤中股價 + alert；匯率盤中每 15 分、盤外每小時
 *   tick_hourly       — 每小時: 非盤中收盤價 + history snapshot
 *   tick_daily_0700 / 0900 / 0930 / 1230 — 美股收盤快照 / 市場日報 + 卡費貸款 + 機票 / 月報（1 號）與月中健檢（15 號）/ 預測與異常
 *   tick_weekly_sun   — 已停用（備份改到 tick_daily_0100），保留 trigger 免重跑 setupTriggers
 *   tick_daily_0100   — 每日 01:00: recurring + 信用卡分期入帳 + 公基金每月計畫 + 清理（歷史價 / 回收桶 / 60 天前 App 內通知）+ 白名單雜湊同步 + 每日備份 + 股市雷達台股籌碼
 *   tick_daily_0800   — 每日 08:00: daily summary + budget warnings + 股市雷達盤前評估
 *   tick_daily_2100   — 每日 21:00: 記帳日報 + 共同帳本報告（依 household 設定頻率）+ 股市雷達美股 fallback 推播
 *   tick_daily_1800   — 每日 18:00: TW 日 K + FX + 短波段 + 台指期虛擬交易（期交所日行情 → 訊號 → 虛擬帳戶；21:00 / 08:00 補跑）
 *   tick_taifex_intraday — 每 5 分鐘：台指期盤中模擬（日盤 08:45–13:45 + 夜盤 15:00–05:00；休市與時段外立刻返回；由 tick_15min 自動安裝）
 *   tick_weekly_sun_2000 — 週日 20:00: 每週回顧（本週支出 + 需要處理事項）+ 股市雷達回測 + 台指期回測
 *   （tick_daily_0800 另跑台指期盤前輿情否決）
 */

function setupTriggers() {
  deleteAllTriggers();
  ScriptApp.newTrigger('tick_15min').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('tick_hourly').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('tick_daily_0100').timeBased().atHour(1).everyDays(1).inTimezone('Asia/Taipei').create();
  ScriptApp.newTrigger('tick_daily_0800').timeBased().atHour(8).everyDays(1).inTimezone('Asia/Taipei').create();
  // TW 收盤 + FX: 台北 18:00 抓 TW 日 K + FX
  ScriptApp.newTrigger('tick_daily_1800').timeBased().atHour(18).everyDays(1).inTimezone('Asia/Taipei').create();
  // US 收盤: 美東 17:00 = 台北 05:00 (EST) / 06:00 (EDT)；用 07:00 穩妥涵蓋
  ScriptApp.newTrigger('tick_daily_0700').timeBased().atHour(7).everyDays(1).inTimezone('Asia/Taipei').create();
  // 市場日報 09:00 (TW 開盤後)
  ScriptApp.newTrigger('tick_daily_0900').timeBased().atHour(9).everyDays(1).inTimezone('Asia/Taipei').create();
  // 記帳日報 21:00
  ScriptApp.newTrigger('tick_daily_2100').timeBased().atHour(21).everyDays(1).inTimezone('Asia/Taipei').create();
  // 月度彙整：每日 09:30 跑，但僅在每月 1 號發
  ScriptApp.newTrigger('tick_daily_0930').timeBased().atHour(9).everyDays(1).inTimezone('Asia/Taipei').create();
  // 預測 / 異常：每日 12:30 跑（避免月初彙整撞）
  ScriptApp.newTrigger('tick_daily_1230').timeBased().atHour(12).everyDays(1).inTimezone('Asia/Taipei').create();
  // 每週備份：週日 03:00
  ScriptApp.newTrigger('tick_weekly_sun').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).inTimezone('Asia/Taipei').create();
  // 每週回顧：週日 20:00
  // 台指期盤中模擬：每 5 分鐘，日盤 08:45–13:45、夜盤 15:00–05:00；休市與時段外立刻返回
  ScriptApp.newTrigger('tick_taifex_intraday').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('tick_weekly_sun_2000').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(20).inTimezone('Asia/Taipei').create();
  return { ok: true };
}

function deleteAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

function tick_15min() {
  try {
    var inMarket = isMarketHours_();
    if (inMarket) {
      updateStockPrices();
    }
    // 匯率：盤中每 15 分；盤外每小時一次（分鐘 < 15 的那一輪）。
    // 以前不分時段每 15 分打一次，FX API + Firestore + 警報檢查一天 96 輪，吃掉不少 UrlFetch 配額（稽核 O2）；
    // 18:00 / 21:00 / 07:00 另有固定的匯率更新，日報數字不受影響。
    var minute = parseInt(Utilities.formatDate(new Date(), 'Asia/Taipei', 'm'), 10);
    if (inMarket || minute < 15) {
      updateFxRates();
    }
    // 台指期盤中模擬的 5 分鐘 trigger：不存在就自動建立（部署後不必手動重跑 setupTriggers）
    try { ensureTaifexIntradayTrigger_(); } catch (trigErr) { console.error('ensureTaifexIntradayTrigger_', trigErr); }
  } catch (err) {
    console.error('tick_15min', err);
    notifyError('tick_15min', err);
  }
}

function tick_hourly() {
  try {
    if (!isMarketHours_()) {
      updateStockPrices();
      // 收盤後不補 history（避免每天寫 24 筆同價，撞 pitfall #5）
      return;
    }
    appendStockHistorySnapshot();
  } catch (err) {
    console.error('tick_hourly', err);
  }
}

function tick_daily_0100() {
  try { runRecurringTransactions(); } catch (err) { console.error('recurring', err); }
  // 信用卡分期：到期的期數入帳到卡片（台北 01:00，pitfall #19；冪等 tx id inst_{planId}_{i}）
  try { runInstallmentPlans(); } catch (err) { console.error('installments', err); notifyError('installments', err); }
  // 共同帳本公基金：每月固定存入 + 固定扣款（台北 01:00 跑，避免 pitfall #19 的 UTC 偏移）
  try { runHouseholdFundPlans(); } catch (err) { console.error('householdFundPlan', err); notifyError('householdFundPlan', err); }
  try { cleanupOldHistory_(); } catch (err) { console.error('cleanup', err); }
  try { cleanupExpiredDeletedTxs_(); } catch (err) { console.error('cleanup-trash', err); }
  // App 內通知保留 60 天（InAppNotifications.gs），每次最多刪 300 筆
  try { cleanupOldNotifications_(); } catch (err) { console.error('cleanup-notifications', err); }
  // 白名單雜湊 doc 與明文名單保持一致（前端登入檢查只讀雜湊）
  try { syncWhitelistHashes_(); } catch (err) { console.error('syncWhitelistHashes', err); }
  // 每日備份到 Drive（SPEC §11.9；原本每週日 03:00，2026-11 改每日、保留 30 天）
  try { dailyBackupRun(); } catch (err) { console.error('dailyBackupRun', err); notifyError('dailyBackup', err); }
  // 電子發票自動同步：Script Properties 沒設就會回 skipped，不會噴錯
  // 股市雷達台股籌碼（三大法人、融資）：前一交易日已公布
  try { syncStockRadarFlows(); } catch (err) { console.error('syncStockRadarFlows', err); notifyError('stockRadarFlows', err); }
  try {
    var einv = syncEInvoices({ daysBack: 7 });
    if (einv && einv.error && !einv.skipped) notifyError('syncEInvoices', new Error(einv.error));
  } catch (err) { console.error('syncEInvoices', err); notifyError('syncEInvoices', err); }
}

function tick_daily_0800() {
  try { sendDailySummary(); } catch (err) { console.error('daily-summary', err); }
  try { notifyErrorDigest(); } catch (err) { console.error('error-digest', err); }
  // 股市雷達：TW 日 K 前一晚 18:00、US 日 K 07:00 已更新，08:00 盤前評估兩個市場並推播台股
  try { runStockRadarScheduled(); } catch (err) { console.error('runStockRadar 0800', err); notifyError('stockRadar', err); }
  // 台指期虛擬交易：08:45 開盤前依盤前輿情否決「新增曝險」的待成交單（只取消、不新增）
  try { taifexPreOpenReview(); } catch (err) { console.error('taifexPreOpenReview 0800', err); notifyError('taifexPreOpen', err); }
}

function tick_daily_1800() {
  try { updateStockPrices(); } catch (err) { console.error('stock-prices 1800', err); }
  try { updateFxRates(); } catch (err) { console.error('fx-rates 1800', err); }
  try { updateDailyCandles(); } catch (err) { console.error('daily-candles 1800', err); }
  try { updateDividendCalendar(); } catch (err) { console.error('updateDividendCalendar 1800', err); }
  try { notifyDividendCalendar(); } catch (err) { console.error('notifyDividendCalendar 1800', err); notifyError('dividendCalendar', err); }
  try { runSwingScanNoLock(); } catch (err) { console.error('swing-scan 1800', err); notifyError('swingScan', err); }
  try { syncSwingPaperTrades(); } catch (err) { console.error('swing-paper 1800', err); notifyError('swingPaper', err); }
  // TW 收盤後再寫一次 portfolio + net worth snapshot（覆寫今天的 dateKey / 本月 doc）
  try { snapshotPortfolioDaily(); } catch (err) { console.error('snapshotPortfolioDaily 1800', err); notifyError('snapshotPortfolio', err); }
  try { snapshotNetWorthMonthly(); } catch (err) { console.error('snapshotNetWorthMonthly 1800', err); notifyError('snapshotNetWorth', err); }
  // 共同投資帳：同步連結部位 + 寫快照
  try { snapshotHouseholdInvestments(); } catch (err) { console.error('snapshotHouseholdInvestments 1800', err); notifyError('householdInvest', err); }
  // 台指期虛擬交易：期交所日行情約 15:00 更新；放最後，避免拖慢其他 18:00 任務
  try { runTaifexDailyScheduled(); } catch (err) { console.error('runTaifexDaily 1800', err); notifyError('taifexDaily', err); }
}

function tick_daily_0700() {
  try { updateStockPrices(); } catch (err) { console.error('stock-prices 0700', err); }
  try { updateFxRates(); } catch (err) { console.error('fx-rates 0700', err); }
  try { updateDailyCandles(); } catch (err) { console.error('daily-candles 0700', err); }
  // 美股收盤後做投資組合每日快照
  try { snapshotPortfolioDaily(); } catch (err) { console.error('snapshotPortfolioDaily 0700', err); notifyError('snapshotPortfolio', err); }
  // 同步寫淨值月度快照（同月覆寫，過去月份凍結）
  try { snapshotNetWorthMonthly(); } catch (err) { console.error('snapshotNetWorthMonthly 0700', err); notifyError('snapshotNetWorth', err); }
  try { snapshotHouseholdInvestments(); } catch (err) { console.error('snapshotHouseholdInvestments 0700', err); notifyError('householdInvest', err); }
}

function tick_daily_0900() {
  try { notifyMarketDaily(); } catch (err) { console.error('notifyMarketDaily', err); notifyError('marketDaily', err); }
  try { notifyCreditCardDues(); } catch (err) { console.error('notifyCreditCardDues', err); notifyError('creditCardDue', err); }
  try { notifyAccountLoansDue(); } catch (err) { console.error('notifyAccountLoansDue', err); notifyError('loanDue', err); }
  try { notifyInsuranceDue(); } catch (err) { console.error('notifyInsuranceDue', err); notifyError('insuranceDue', err); }
  // 沿用既有 09:00 trigger，部署後不需人工重建 trigger；fetchAll 批次最多 10 筆避免超過執行上限。
  try { scanFlightWatches(); } catch (err) { console.error('scanFlightWatches', err); notifyError('flightWatches', err); }
}

function tick_daily_2100() {
  try { notifyLedgerDaily(); } catch (err) { console.error('notifyLedgerDaily', err); notifyError('ledgerDaily', err); }
  try { notifyBudgetWarn(); } catch (err) { console.error('notifyBudgetWarn', err); }
  try { notifyLoansReminder(); } catch (err) { console.error('notifyLoansReminder', err); }
  try { notifyPayoutGroupsReminder(); } catch (err) { console.error('notifyPayoutGroupsReminder', err); }
  // 共同帳本獨立報告（每個 household 自己設定 daily / weekly / monthly，發給已綁定 Telegram 的成員）
  try { runHouseholdReports(false); } catch (err) { console.error('runHouseholdReports', err); notifyError('householdReport', err); }
  // 股市雷達美股：20:30 Claude 排程沒推送就推播純量化結果
  try { notifyStockRadarFallback_(); } catch (err) { console.error('notifyStockRadarFallback_', err); }
  // 21:00 抓最終匯率（晚於亞洲收盤、含 NY 開盤期間 → 已穩定）+ 通知
  try {
    var fxResult = updateFxRates();
    notifyFxDaily(fxResult);
  } catch (err) {
    console.error('fx daily 21:00', err);
    notifyError('fxDaily', err);
  }
  // 台指期補跑：18:00 若期交所資料還沒更新或逾時，21:00 再試一次（已處理的 K 棒不會重複）
  try { runTaifexDailyScheduled(); } catch (err) { console.error('runTaifexDaily 2100', err); notifyError('taifexDaily', err); }
}

function tick_daily_0930() {
  // 月中理財健檢：避開每月 1 號既有多則月報，降低 Telegram 噪音。
  var d = parseInt(Utilities.formatDate(new Date(), 'Asia/Taipei', 'd'), 10);
  if (d === 15) {
    try { notifyFinancialHealthDigest(); } catch (err) {
      console.error('notifyFinancialHealthDigest', err);
      notifyError('financialHealthDigest', err);
    }
    return;
  }
  // 其餘月度彙整僅每月 1 號跑。
  if (d !== 1) return;
  // 報稅季：4/1 與 5/1 整理去年股利 / 海外所得
  var mo = parseInt(Utilities.formatDate(new Date(), 'Asia/Taipei', 'M'), 10);
  if (mo === 4 || mo === 5) {
    try { notifyTaxSeason(); } catch (err) { console.error('notifyTaxSeason', err); notifyError('taxSeason', err); }
  }
  try { notifyLedgerMonthly(); } catch (err) { console.error('notifyLedgerMonthly', err); notifyError('ledgerMonthly', err); }
  try { notifySubscriptionsDigest(); } catch (err) { console.error('notifySubscriptionsDigest', err); notifyError('subscriptionsDigest', err); }
  try { notifyFixedExpensesMonthly(); } catch (err) { console.error('notifyFixedExpensesMonthly', err); notifyError('fixedExpensesMonthly', err); }
  try { notifyTripRecap(); } catch (err) { console.error('notifyTripRecap', err); notifyError('tripRecap', err); }
  try { notifySavingsGoalProgress(); } catch (err) { console.error('notifySavingsGoalProgress', err); notifyError('savingsGoalProgress', err); }
  try { notifyInvestmentPlanProgress(); } catch (err) { console.error('notifyInvestmentPlanProgress', err); notifyError('investmentPlanProgress', err); }
}

function tick_daily_1230() {
  try { notifyMonthlyForecast(); } catch (err) { console.error('notifyMonthlyForecast', err); notifyError('monthlyForecast', err); }
  try { notifyCategoryAnomaly(); } catch (err) { console.error('notifyCategoryAnomaly', err); notifyError('categoryAnomaly', err); }
  try { notifyScheduledPaymentDue(); } catch (err) { console.error('notifyScheduledPaymentDue', err); notifyError('scheduledPaymentDue', err); }
}

function tick_weekly_sun() {
  // 備份已改每日（tick_daily_0100 → dailyBackupRun）；trigger 保留不動避免要重跑 setupTriggers，這裡沒事做
  return { ok: true, skipped: 'backup moved to tick_daily_0100' };
}

function tick_weekly_sun_2000() {
  try { notifyWeeklyReview(); } catch (err) { console.error('notifyWeeklyReview', err); notifyError('weeklyReview', err); }
  // 股市雷達回測：用 Yahoo 5 年日 K 重算（只讀不寫 K 線），週日晚上跑，避開 03:00 的備份
  try { runStockRadarBacktest(); } catch (err) { console.error('runStockRadarBacktest', err); notifyError('stockRadarBacktest', err); }
  // 台指期回測：讀 taifex_daily（已存在 Firestore），完整策略 / 純趨勢 / 大盤三組對照
  try { runTaifexBacktest(); } catch (err) { console.error('runTaifexBacktest', err); notifyError('taifexBacktest', err); }
  // 台指期參數最佳化（walk-forward）：optimized 策略變體下週起用新參數
  try { runTaifexOptimization(); } catch (err) { console.error('runTaifexOptimization', err); notifyError('taifexOptimization', err); }
}

/**
 * Is current time within either TW or US market hours?
 */
function isMarketHours_() {
  var now = new Date();
  // TW: Mon–Fri 09:00–13:30 Asia/Taipei
  var twHour = parseInt(Utilities.formatDate(now, 'Asia/Taipei', 'H'), 10);
  var twMin = parseInt(Utilities.formatDate(now, 'Asia/Taipei', 'm'), 10);
  var twDay = parseInt(Utilities.formatDate(now, 'Asia/Taipei', 'u'), 10); // 1-7 Mon-Sun
  var twIn = twDay >= 1 && twDay <= 5 && ((twHour > 9 && (twHour < 13 || (twHour === 13 && twMin <= 30))) || (twHour === 9));
  if (twIn) return true;

  // US: Mon–Fri 09:30–16:00 America/New_York
  var usHour = parseInt(Utilities.formatDate(now, 'America/New_York', 'H'), 10);
  var usMin = parseInt(Utilities.formatDate(now, 'America/New_York', 'm'), 10);
  var usDay = parseInt(Utilities.formatDate(now, 'America/New_York', 'u'), 10);
  var usIn = usDay >= 1 && usDay <= 5
    && ((usHour > 9 || (usHour === 9 && usMin >= 30)) && usHour < 16);
  return usIn;
}

/**
 * Delete stock history older than 30 days (to keep collection small)
 */
/**
 * 永久刪除超過 7 天還在 trash 的 transactions。
 */
function cleanupExpiredDeletedTxs_() {
  var cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  var docs;
  try {
    docs = fsRunQuery_('', {
      from: [{ collectionId: 'transactions' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'deletedAt' },
          op: 'LESS_THAN',
          value: { timestampValue: cutoff.toISOString() },
        },
      },
      limit: 200,
    });
  } catch (err) {
    console.warn('cleanupExpiredDeletedTxs_ query', err);
    return;
  }
  if (!docs || docs.length === 0) return;
  // 一次 batchWrite 刪掉（以前逐筆 DELETE，200 筆 = 200 次 UrlFetch，稽核 O3）
  var writes = docs
    .filter(function (d) { return d.deletedAt && d._name; })
    .map(function (d) { return { delete: d._name }; });
  if (!writes.length) return;
  try {
    fsBatchWrite_(writes);
    console.log('Cleaned up ' + writes.length + ' expired soft-deleted transactions');
  } catch (err) {
    console.warn('cleanup trash batch delete failed', err);
  }
}

function cleanupOldHistory_() {
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  var stocks = fsListAllDocs_('stocks', 200);
  stocks.forEach(function (s) {
    if (!s.symbol) return;
    try {
      var hist = fsRunQuery_('stocks/' + s.symbol, {
        from: [{ collectionId: 'history' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'timestamp' },
            op: 'LESS_THAN',
            value: { timestampValue: cutoff.toISOString() },
          },
        },
        limit: 100,
      });
      if (hist.length === 0) return;
      var histWrites = hist.filter(function (h) { return h._name; }).map(function (h) { return { delete: h._name }; });
      if (histWrites.length) fsBatchWrite_(histWrites);
    } catch (err) {
      console.warn('cleanup history', s.symbol, err);
    }
  });
}
