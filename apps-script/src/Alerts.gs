/**
 * Alerts engine
 * - Scan alerts collection
 * - For each active alert, compare current value against threshold
 * - Respect cooldownMinutes
 * - On trigger: write alert_logs + send Telegram
 */

function checkAllAlerts() {
  var alerts = fsListAllDocs_('alerts', 200);
  var now = new Date();
  var triggered = 0;
  alerts.forEach(function (alert) {
    try {
      if (!alert.active) return;
      if (alert.lastTriggeredAt) {
        var last = alert.lastTriggeredAt instanceof Date
          ? alert.lastTriggeredAt
          : new Date(alert.lastTriggeredAt);
        var cooldown = (alert.cooldownMinutes || 60) * 60 * 1000;
        if (now - last < cooldown) return;
      }
      var current = null;
      var metric = alert.metric || 'price';
      if (alert.type === 'fx') {
        var fx = fsGetDoc_('fx_rates/' + alert.target);
        if (fx) current = fx.rate;
      } else if (alert.type === 'stock') {
        current = computeStockMetric_(alert.target, metric, alert.threshold);
      }
      if (current === null || current === undefined) return;

      var hit;
      if (metric === 'high52w' || metric === 'low52w') {
        // computeStockMetric_ 回 1 = 已創新高 / 新低，0 = 沒有
        hit = current === 1;
      } else if (metric === 'ma') {
        // current = 現價 − 均線 的百分比；above = 站上（≥ 0）、below = 跌破（≤ 0）
        hit = (alert.direction === 'above' && current >= 0) || (alert.direction === 'below' && current <= 0);
      } else {
        hit = (alert.direction === 'above' && current >= alert.threshold)
          || (alert.direction === 'below' && current <= alert.threshold);
      }
      if (!hit) return;

      var alertId = (alert._name || '').split('/').pop();
      fsAddDoc_('alert_logs', {
        alertId: alertId,
        triggeredAt: now,
        triggerValue: current,
        notificationSent: true,
        channel: 'telegram',
      });

      var message = formatAlertMessage_(alert, current);
      if (alert.oneShot === true) message += '\n（一次性警報，已自動停用）';
      sendNotification_('alertHit', message);

      // Update lastTriggeredAt；一次性警報觸發後自動停用（SPEC §5.3.1）
      var patch = { lastTriggeredAt: now };
      if (alert.oneShot === true) patch.active = false;
      fsSetDoc_('alerts/' + alertId, patch, true);

      triggered++;
    } catch (err) {
      console.error('alert check failed', alert._name, err);
    }
  });
  return { ok: true, triggered: triggered, scanned: alerts.length };
}

/**
 * 依 metric 算出比較值：
 *   price    現價
 *   rsi14    RSI
 *   ma       (現價 − MA(N)) / MA(N) × 100，N = threshold
 *   high52w  現價 ≥ 近 52 週最高收盤 → 1，否則 0
 *   low52w   現價 ≤ 近 52 週最低收盤 → 1，否則 0
 *   vsCost   (現價 − 平均成本) / 平均成本 × 100（portfolio 沒有此檔 → null）
 *   weight   該檔市值佔最新投資快照總市值 %（快照沒有此檔 → null）
 */
function computeStockMetric_(symbol, metric, threshold) {
  if (metric === 'rsi14') return computeRsi14_(symbol);
  var stock = fsGetDoc_('stocks/' + symbol);
  if (!stock || !stock.currentPrice) return null;
  var price = Number(stock.currentPrice);
  if (metric === 'price') return price;

  if (metric === 'ma') {
    var n = Math.max(2, parseInt(threshold, 10) || 60);
    var closes = recentCloses_(symbol, n);
    if (!closes || closes.length < n) return null;
    var sum = 0;
    for (var i = closes.length - n; i < closes.length; i++) sum += closes[i];
    var ma = sum / n;
    return ma ? ((price - ma) / ma) * 100 : null;
  }
  if (metric === 'high52w' || metric === 'low52w') {
    var year = recentCloses_(symbol, 250);
    if (!year || year.length < 60) return null; // 資料太少不判斷
    var hi = -Infinity, lo = Infinity;
    // 排除最後一根（今天的收盤可能就是 currentPrice），比較「之前」的極值
    for (var j = 0; j < year.length - 1; j++) { if (year[j] > hi) hi = year[j]; if (year[j] < lo) lo = year[j]; }
    return metric === 'high52w' ? (price >= hi ? 1 : 0) : (price <= lo ? 1 : 0);
  }
  if (metric === 'vsCost') {
    var pos = findPosition_(symbol);
    if (!pos || !pos.avgCost) return null;
    return ((price - pos.avgCost) / pos.avgCost) * 100;
  }
  if (metric === 'weight') {
    var snap = getLatestSnapshot_();
    if (!snap || !snap.totalValueTWD) return null;
    var p = (snap.positions || []).filter(function (x) { return x.symbol === symbol; })[0];
    if (!p) return null;
    return ((p.valueTWD || 0) / snap.totalValueTWD) * 100;
  }
  return price;
}

/** 由舊到新的收盤價陣列（最多 limit 根） */
function recentCloses_(symbol, limit) {
  try {
    var candles = fsRunQuery_('stocks/' + symbol, {
      from: [{ collectionId: 'candles' }],
      orderBy: [{ field: { fieldPath: 'date' }, direction: 'DESCENDING' }],
      limit: limit,
    });
    if (!candles || !candles.length) return null;
    return candles.reverse().map(function (c) { return Number(c.close) || 0; }).filter(function (v) { return v > 0; });
  } catch (err) {
    console.warn('recentCloses_', symbol, err);
    return null;
  }
}

function findPosition_(symbol) {
  try {
    var positions = fsListAllDocs_('portfolio', 200);
    for (var i = 0; i < positions.length; i++) {
      if (positions[i].symbol === symbol && positions[i].shares) return positions[i];
    }
  } catch (err) { console.warn('findPosition_', err); }
  return null;
}

/**
 * 計算 14 日 RSI（Wilder's smoothing）。需要 stocks/{symbol}/candles 至少 15 筆日 K。
 */
function computeRsi14_(symbol) {
  try {
    var candles = fsRunQuery_('stocks/' + symbol, {
      from: [{ collectionId: 'candles' }],
      orderBy: [{ field: { fieldPath: 'date' }, direction: 'DESCENDING' }],
      limit: 30,
    });
    if (!candles || candles.length < 15) return null;
    candles.reverse(); // 由舊到新
    var period = 14;
    var gains = 0, losses = 0;
    for (var i = 1; i <= period; i++) {
      var change = candles[i].close - candles[i - 1].close;
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }
    var avgGain = gains / period;
    var avgLoss = losses / period;
    for (var j = period + 1; j < candles.length; j++) {
      var c = candles[j].close - candles[j - 1].close;
      if (c > 0) {
        avgGain = (avgGain * (period - 1) + c) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.abs(c)) / period;
      }
    }
    if (avgLoss === 0) return 100;
    var rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  } catch (err) {
    console.warn('computeRsi14_ failed', symbol, err);
    return null;
  }
}
