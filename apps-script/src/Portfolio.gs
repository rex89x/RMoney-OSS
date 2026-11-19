/**
 * Portfolio daily snapshot
 *
 * 每天台北 07:00（美股收盤後）跑一次 snapshotPortfolioDaily()，
 * 把當下 portfolio × stocks.currentPrice × fx_rates 計算成 TWD，
 * 寫入 portfolio_snapshots/{YYYY-MM-DD} (id = 前一交易日的日期 / 今日的日期)。
 *
 * 設計：
 * - doc id 用今日（台北）YYYY-MM-DD；同日重跑 overwrite
 * - dayChange 對比前一筆 snapshot 的 totalValueTWD（不是 stock.change，
 *   因為 stock.change 是「對前一交易日收盤」，與我們的 daily snapshot 邏輯一致）
 * - fxRatesUsed 凍結當下匯率，歷史曲線不會被未來匯率變動覆寫（CLAUDE.md §12 / pitfall #3）
 * - 沒有持倉 → 不寫 doc
 */

function snapshotPortfolioDaily() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { ok: false, error: 'could not acquire lock' };
  }
  try {
    var positions = fsListAllDocs_('portfolio', 200);
    if (!positions || positions.length === 0) {
      return { ok: true, skipped: true, reason: 'no positions' };
    }

    // 取必要的 stocks
    var symbolSet = {};
    positions.forEach(function (p) { if (p.symbol && p.shares) symbolSet[p.symbol] = true; });
    var symbols = Object.keys(symbolSet);
    var stocks = {};
    symbols.forEach(function (sym) {
      try {
        var s = fsGetDoc_('stocks/' + sym);
        if (s) stocks[sym] = s;
      } catch (err) { console.warn('snapshot get stock', sym, err); }
    });

    // 收集 positions 用到的所有幣別 → 全部讀 fx_rates/{ccy}_TWD
    var ccyNeeded = {};
    positions.forEach(function (p) {
      if (!p.symbol || !p.shares) return;
      var stock = stocks[p.symbol];
      if (!stock) return;
      var inferredMarket = isTwSymbol_(p.symbol) ? 'TW' : (stock.market || 'US');
      var ccy = stock.currency || (inferredMarket === 'TW' ? twSymbolCurrency_(p.symbol) : 'USD');
      if (ccy && ccy !== 'TWD') ccyNeeded[ccy] = true;
    });
    var fxByCcy = { TWD: 1 };
    var fxRatesUsed = {};
    Object.keys(ccyNeeded).forEach(function (ccy) {
      try {
        var fxDoc = fsGetDoc_('fx_rates/' + ccy + '_TWD');
        if (fxDoc && fxDoc.rate) {
          fxByCcy[ccy] = fxDoc.rate;
          fxRatesUsed[ccy + '/TWD'] = fxDoc.rate;
        } else {
          console.warn('snapshot fx missing', ccy + '_TWD');
        }
      } catch (err) { console.warn('snapshot fx', ccy, err); }
    });

    // 計算各持倉
    var snapshotPositions = [];
    var totalValueTWD = 0;
    var totalCostTWD = 0;
    var byMarket = {};
    var skippedMissingFx = [];

    positions.forEach(function (p) {
      if (!p.symbol || !p.shares) return;
      var stock = stocks[p.symbol];
      if (!stock || !stock.currentPrice) return;
      var market = isTwSymbol_(p.symbol) ? 'TW' : (stock.market || 'US');
      var stockCcy = stock.currency || (market === 'TW' ? twSymbolCurrency_(p.symbol) : 'USD');
      var fxRate = fxByCcy[stockCcy];
      if (fxRate == null) {
        // 沒有匯率資料就跳過該部位（不要靜默用 1 算錯）
        skippedMissingFx.push(p.symbol + ' (' + stockCcy + ')');
        return;
      }
      var costNative = (p.avgCost || 0) * p.shares;
      var valueNative = stock.currentPrice * p.shares;
      var costTWD = costNative * fxRate;
      var valueTWD = valueNative * fxRate;
      var pnlTWD = valueTWD - costTWD;
      var pnlPct = costTWD ? (pnlTWD / costTWD * 100) : 0;
      var dayChangeNative = (stock.change || 0) * p.shares;
      var dayChangeTWD = dayChangeNative * fxRate;

      snapshotPositions.push({
        symbol: p.symbol,
        market: market,
        shares: p.shares,
        avgCost: p.avgCost || 0,
        currentPrice: stock.currentPrice,
        fxRate: fxRate,
        costTWD: round2_(costTWD),
        valueTWD: round2_(valueTWD),
        pnlTWD: round2_(pnlTWD),
        pnlPct: round2_(pnlPct),
        dayChangeTWD: round2_(dayChangeTWD),
      });

      totalValueTWD += valueTWD;
      totalCostTWD += costTWD;

      if (!byMarket[market]) byMarket[market] = { valueTWD: 0, costTWD: 0, pnlTWD: 0, dayChangeTWD: 0 };
      byMarket[market].valueTWD += valueTWD;
      byMarket[market].costTWD += costTWD;
      byMarket[market].pnlTWD += pnlTWD;
      byMarket[market].dayChangeTWD += dayChangeTWD;
    });

    if (snapshotPositions.length === 0) {
      return { ok: true, skipped: true, reason: 'no priced positions' };
    }

    // 對比前一筆 snapshot
    var dateKey = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
    var prev = getPrevSnapshot_(dateKey);
    var dayChangeTWD = prev ? totalValueTWD - prev.totalValueTWD : 0;
    var dayChangePct = (prev && prev.totalValueTWD)
      ? (dayChangeTWD / prev.totalValueTWD * 100)
      : 0;

    var unrealizedPnlTWD = totalValueTWD - totalCostTWD;
    var unrealizedPnlPct = totalCostTWD ? (unrealizedPnlTWD / totalCostTWD * 100) : 0;

    Object.keys(byMarket).forEach(function (mk) {
      byMarket[mk].valueTWD = round2_(byMarket[mk].valueTWD);
      byMarket[mk].costTWD = round2_(byMarket[mk].costTWD);
      byMarket[mk].pnlTWD = round2_(byMarket[mk].pnlTWD);
      byMarket[mk].dayChangeTWD = round2_(byMarket[mk].dayChangeTWD);
    });

    var docData = {
      date: dateKey,
      totalValueTWD: round2_(totalValueTWD),
      totalCostTWD: round2_(totalCostTWD),
      unrealizedPnlTWD: round2_(unrealizedPnlTWD),
      unrealizedPnlPct: round2_(unrealizedPnlPct),
      dayChangeTWD: round2_(dayChangeTWD),
      dayChangePct: round2_(dayChangePct),
      byMarket: byMarket,
      positions: snapshotPositions,
      fxRatesUsed: fxRatesUsed,
      createdAt: new Date(),
    };

    fsSetDoc_('portfolio_snapshots/' + dateKey, docData, false);
    if (skippedMissingFx.length) {
      console.warn('snapshotPortfolioDaily skipped (missing FX):', skippedMissingFx.join(', '));
    }
    return { ok: true, date: dateKey, totalValueTWD: docData.totalValueTWD,
      dayChangeTWD: docData.dayChangeTWD, positions: snapshotPositions.length,
      skippedMissingFx: skippedMissingFx };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Manual portfolio refresh used by the web UI.
 * Update market data first, then write today's snapshot so the "refresh"
 * action reflects current stocks and FX instead of only reusing stale docs.
 */
function refreshPortfolioSnapshot() {
  var stockResult = null;
  var fxResult = null;
  var snapshotResult = null;
  try {
    stockResult = updateStockPrices();
  } catch (err) {
    stockResult = { ok: false, error: String(err && err.message || err) };
  }
  try {
    fxResult = updateFxRates();
  } catch (err2) {
    fxResult = { ok: false, error: String(err2 && err2.message || err2) };
  }
  snapshotResult = snapshotPortfolioDaily();
  var ok = !!(snapshotResult && snapshotResult.ok)
    && !(stockResult && stockResult.ok === false)
    && !(fxResult && fxResult.ok === false);
  return {
    ok: ok,
    error: ok ? null : 'portfolio refresh completed with failed market data update',
    stockResult: stockResult,
    fxResult: fxResult,
    snapshotResult: snapshotResult,
  };
}

/**
 * 找出比 currentDateKey 早的最近一筆 snapshot（用 query 而非 list 全部）。
 * 若沒有任何前筆 → 回 null（首次跑時 dayChange = 0）。
 */
function getPrevSnapshot_(currentDateKey) {
  try {
    var docs = fsRunQuery_('', {
      from: [{ collectionId: 'portfolio_snapshots' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'date' },
          op: 'LESS_THAN',
          value: { stringValue: currentDateKey },
        },
      },
      orderBy: [{ field: { fieldPath: 'date' }, direction: 'DESCENDING' }],
      limit: 1,
    });
    return (docs && docs[0]) ? docs[0] : null;
  } catch (err) {
    console.warn('getPrevSnapshot_', err);
    return null;
  }
}

function round2_(n) {
  if (n == null || isNaN(n)) return 0;
  return Math.round(n * 100) / 100;
}
