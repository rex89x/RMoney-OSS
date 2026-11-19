/**
 * 共同投資帳（households/{hid}/investment_holdings）
 *
 * - 持股分兩種 bucket：
 *     joint    — 兩人共同持有，依 jointShares（%）歸屬；沒設就用 household.splitRatio
 *     personal — 某位成員自己的（ownerUid）；owner 可把自己 portfolio 的部位「連結」進來（source = 'portfolio'）
 * - 計算邏輯與前端 features/joint-investments/calc.ts 一致（平均成本法）：
 *     buy : cost += shares * price + fee; shares += n
 *     sell: realized += n * price - fee - avg * n; cost -= avg * n; shares -= n
 * - snapshotHouseholdInvestments() 每天 07:00 / 18:00 跟著 portfolio snapshot 一起跑，
 *   寫 households/{hid}/investment_snapshots/{YYYY-MM-DD}（前端歷史走勢圖、Telegram 報告用）
 * - 連結部位（source = 'portfolio'）在 snapshot 前會先從 portfolio/{id} 同步股數與均價，
 *   owner 在投資頁加減碼後，共同投資帳隔天自動跟上（前端也有「立即同步」按鈕）
 */

var HH_HOLDINGS_LIMIT_ = 200;

/** 平均成本法彙總 lots → { shares, costNative, realizedNative } */
function hhSummarizeLots_(lots) {
  var shares = 0;
  var cost = 0;
  var realized = 0;
  (Array.isArray(lots) ? lots.slice() : [])
    .sort(function (a, b) { return new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime(); })
    .forEach(function (lot) {
      var n = Number(lot.shares) || 0;
      var price = Number(lot.price) || 0;
      var fee = Number(lot.fee) || 0;
      if (n <= 0) return;
      if (lot.side === 'sell') {
        var sellN = Math.min(n, shares);
        if (sellN <= 0) return;
        var avg = shares > 0 ? cost / shares : 0;
        realized += sellN * price - fee - avg * sellN;
        cost -= avg * sellN;
        shares -= sellN;
      } else {
        cost += n * price + fee;
        shares += n;
      }
    });
  if (shares < 1e-9) { shares = 0; cost = 0; }
  return { shares: shares, costNative: cost, realizedNative: realized };
}

/** 持股歸屬：回傳 { uid: fraction }，加總 = 1 */
function hhHoldingAttribution_(holding, hh) {
  var memberIds = Array.isArray(hh.memberIds) ? hh.memberIds : [];
  if (holding.bucket === 'personal') {
    var out = {};
    if (holding.ownerUid) out[holding.ownerUid] = 1;
    return out;
  }
  var raw = (holding.jointShares && typeof holding.jointShares === 'object') ? holding.jointShares : (hh.splitRatio || {});
  var total = 0;
  memberIds.forEach(function (id) { total += Math.max(0, Number(raw[id]) || 0); });
  var res = {};
  memberIds.forEach(function (id) {
    res[id] = total > 0 ? Math.max(0, Number(raw[id]) || 0) / total : 1 / (memberIds.length || 1);
  });
  return res;
}

function hhListHoldings_(hid) {
  return fsListDocs_('households/' + hid + '/investment_holdings', HH_HOLDINGS_LIMIT_)
    .filter(function (h) { return h && h.symbol && !h.archivedAt; });
}

/** 所有 household 的持股 symbol（給 listTrackedStockSymbols_，讓伴侶自己的股票也會自動更新股價） */
function listHouseholdHoldingSymbols_() {
  var out = [];
  try {
    fsRunQuery_('', {
      from: [{ collectionId: 'investment_holdings', allDescendants: true }],
      limit: 500,
    }).forEach(function (h) {
      if (!h.symbol || h.archivedAt) return;
      out.push({ symbol: h.symbol, market: h.market || (h.currency === 'USD' ? 'US' : null) });
    });
  } catch (err) {
    console.warn('listHouseholdHoldingSymbols_', err);
  }
  return out;
}

/** 連結部位：從 owner 的 portfolio/{id} 同步股數與均價（部位已刪除 → 股數歸零並標記） */
function hhSyncLinkedHoldings_(hid, holdings) {
  var synced = 0;
  holdings.forEach(function (h) {
    if (h.source !== 'portfolio' || !h.sourcePositionId) return;
    var id = String(h._name).split('/').pop();
    var pos = null;
    try { pos = fsGetDoc_('portfolio/' + h.sourcePositionId); } catch (err) { console.warn('hhSync get', err); return; }
    var shares = pos ? Number(pos.shares) || 0 : 0;
    var avgCost = pos ? Number(pos.avgCost) || 0 : 0;
    var current = hhSummarizeLots_(h.lots);
    var currentAvg = current.shares > 0 ? current.costNative / current.shares : 0;
    if (Math.abs(current.shares - shares) < 1e-9 && Math.abs(currentAvg - avgCost) < 1e-6 && !!pos === !h.sourceMissing) return;
    var lots = shares > 0 ? [{ side: 'buy', date: new Date(), shares: shares, price: avgCost, fee: 0 }] : [];
    fsSetDoc_('households/' + hid + '/investment_holdings/' + id, {
      lots: lots,
      sourceMissing: !pos,
      syncedAt: new Date(),
      updatedAt: new Date(),
    }, true);
    h.lots = lots;
    synced++;
  });
  return synced;
}

/**
 * 估值：回傳 { totalValueTWD, totalCostTWD, unrealizedTWD, realizedTWD, dayChangeTWD,
 *               byBucket: { joint|uid: {...} }, byMember: { uid: {...} }, positions: [...] , missingPrices: [] }
 * byBucket 的 key：'joint' 或 personal 持有人的 uid；byMember 是依歸屬比例攤到每個人身上的金額。
 */
function hhValueHoldings_(hh, holdings) {
  var stocks = {};
  var fx = { TWD: 1 };
  var fxUsed = {};
  holdings.forEach(function (h) {
    var sym = h.symbol;
    if (stocks[sym] !== undefined) return;
    try { stocks[sym] = fsGetDoc_('stocks/' + sym) || null; } catch (err) { stocks[sym] = null; }
  });
  holdings.forEach(function (h) {
    var ccy = h.currency || 'TWD';
    if (fx[ccy] !== undefined) return;
    try {
      var d = fsGetDoc_('fx_rates/' + ccy + '_TWD');
      fx[ccy] = d && d.rate ? Number(d.rate) : null;
      if (fx[ccy]) fxUsed[ccy + '/TWD'] = fx[ccy];
    } catch (err) { fx[ccy] = null; }
  });

  var emptyAgg = function () { return { valueTWD: 0, costTWD: 0, unrealizedTWD: 0, realizedTWD: 0, dayChangeTWD: 0 }; };
  var res = {
    totalValueTWD: 0, totalCostTWD: 0, unrealizedTWD: 0, realizedTWD: 0, dayChangeTWD: 0,
    byBucket: {}, byMember: {}, positions: [], missingPrices: [], fxRatesUsed: fxUsed,
  };
  (hh.memberIds || []).forEach(function (id) { res.byMember[id] = emptyAgg(); });

  holdings.forEach(function (h) {
    var sum = hhSummarizeLots_(h.lots);
    var rate = fx[h.currency || 'TWD'];
    if (!rate) { res.missingPrices.push(h.symbol + ' (' + (h.currency || '?') + ' 匯率)'); return; }
    var st = stocks[h.symbol];
    var price = st && Number(st.currentPrice) > 0 ? Number(st.currentPrice) : 0;
    if (sum.shares > 0 && !price) res.missingPrices.push(h.symbol);
    // 沒有報價時市值以成本計，避免總額突然掉成 0
    var valueNative = price ? sum.shares * price : sum.costNative;
    var agg = {
      valueTWD: valueNative * rate,
      costTWD: sum.costNative * rate,
      unrealizedTWD: (valueNative - sum.costNative) * rate,
      realizedTWD: sum.realizedNative * rate,
      dayChangeTWD: price ? (Number(st.change) || 0) * sum.shares * rate : 0,
    };
    var bucketKey = h.bucket === 'personal' ? (h.ownerUid || 'unknown') : 'joint';
    if (!res.byBucket[bucketKey]) res.byBucket[bucketKey] = emptyAgg();
    var attribution = hhHoldingAttribution_(h, hh);
    Object.keys(agg).forEach(function (k) {
      res[k === 'valueTWD' ? 'totalValueTWD' : k === 'costTWD' ? 'totalCostTWD' : k] += agg[k];
      res.byBucket[bucketKey][k] += agg[k];
      Object.keys(attribution).forEach(function (uid) {
        if (!res.byMember[uid]) res.byMember[uid] = emptyAgg();
        res.byMember[uid][k] += agg[k] * attribution[uid];
      });
    });
    if (sum.shares > 0) {
      res.positions.push({
        symbol: h.symbol,
        name: h.name || (st && st.name) || h.symbol,
        bucket: bucketKey,
        shares: sum.shares,
        valueTWD: round2_(agg.valueTWD),
        costTWD: round2_(agg.costTWD),
        unrealizedTWD: round2_(agg.unrealizedTWD),
        pnlPct: agg.costTWD ? round2_(agg.unrealizedTWD / agg.costTWD * 100) : 0,
      });
    }
  });

  var roundAgg = function (a) { Object.keys(a).forEach(function (k) { a[k] = round2_(a[k]); }); return a; };
  ['totalValueTWD', 'totalCostTWD', 'unrealizedTWD', 'realizedTWD', 'dayChangeTWD'].forEach(function (k) { res[k] = round2_(res[k]); });
  Object.keys(res.byBucket).forEach(function (k) { roundAgg(res.byBucket[k]); });
  Object.keys(res.byMember).forEach(function (k) { roundAgg(res.byMember[k]); });
  res.positions.sort(function (a, b) { return b.valueTWD - a.valueTWD; });
  return res;
}

/** 每日：同步連結部位 + 寫共同投資快照（所有有持股的 household） */
function snapshotHouseholdInvestments() {
  var households = [];
  try { households = fsListAllDocs_('households', 50); } catch (err) {
    console.warn('snapshotHouseholdInvestments list', err);
    return { ok: false, error: String(err && err.message || err) };
  }
  var dateKey = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var written = [];
  households.forEach(function (hh) {
    var hid = String(hh._name).split('/').pop();
    try {
      var holdings = hhListHoldings_(hid);
      if (!holdings.length) return;
      hhSyncLinkedHoldings_(hid, holdings);
      var v = hhValueHoldings_(hh, holdings);
      fsSetDoc_('households/' + hid + '/investment_snapshots/' + dateKey, {
        date: dateKey,
        totalValueTWD: v.totalValueTWD,
        totalCostTWD: v.totalCostTWD,
        unrealizedTWD: v.unrealizedTWD,
        realizedTWD: v.realizedTWD,
        dayChangeTWD: v.dayChangeTWD,
        byBucket: v.byBucket,
        byMember: v.byMember,
        positions: v.positions.slice(0, 50),
        fxRatesUsed: v.fxRatesUsed,
        createdAt: new Date(),
      }, false);
      written.push(hid);
    } catch (err) {
      console.error('snapshotHouseholdInvestments', hid, err);
    }
  });
  return { ok: true, date: dateKey, households: written };
}

/** 呼叫者必須是 household 成員；回傳 household doc（含 _name）或 throw */
function hhRequireMember_(hid, authResult) {
  if (!hid) throw new Error('missing householdId');
  var hh = fsGetDoc_('households/' + hid);
  if (!hh) throw new Error('household-not-found');
  var uid = String((authResult && authResult.uid) || '');
  if (!uid || !Array.isArray(hh.memberIds) || hh.memberIds.indexOf(uid) < 0) throw new Error('not-household-member');
  return hh;
}

/**
 * 前端「更新報價」：只更新這個 household 持股的 symbol（最多 20 檔），
 * 成員（伴侶）也能按，但不會觸發 owner 全部的股價 / 快照流程。
 */
function refreshHouseholdQuotes(body, authResult) {
  var hid = String((body && body.householdId) || '');
  var hh = hhRequireMember_(hid, authResult);
  var cache = CacheService.getScriptCache();
  var cooldownKey = 'hhQuotes-' + hid;
  if (cache.get(cooldownKey)) return { ok: false, error: '剛剛才更新過，請一分鐘後再試' };
  cache.put(cooldownKey, '1', 60);

  var holdings = hhListHoldings_(hid);
  if (authResult.uid === hh.ownerId) hhSyncLinkedHoldings_(hid, holdings);
  // 依持股記錄的 market 分組（inferStockMarket_ 只認 4 碼數字，00878 這類 ETF 會被誤判成美股）
  var seen = {};
  var tw = [];
  var us = [];
  holdings.forEach(function (h) {
    var sym = normalizeStockSymbol_(h.symbol);
    if (!sym || seen[sym]) return;
    seen[sym] = true;
    var market = h.market || (h.currency === 'USD' ? 'US' : /^\d+[A-Z]?$/.test(sym) ? 'TW' : 'US');
    (market === 'TW' ? tw : us).push(sym);
  });
  tw = tw.slice(0, 20);
  us = us.slice(0, 10);
  var got = {};
  try { if (tw.length) updateTwStocks_(tw, got); } catch (err) { console.warn('refreshHouseholdQuotes tw', err); }
  try { if (us.length) updateUsStocks_(us, got); } catch (err) { console.warn('refreshHouseholdQuotes us', err); }
  var all = tw.concat(us);
  var failed = all.filter(function (sym) { return !got[sym]; });
  return { ok: true, updated: all.length - failed.length, failed: failed };
}
