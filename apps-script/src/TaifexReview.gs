/**
 * TaifexReview — 台指期「每週檢討 → 調校提案 → owner 核准」的 IO 層。
 * 純函式在 TaifexTuning.gs；規劃見 docs/TAIFEX_PAPER_TRADING_PLAN.md §13、docs/MCP_TOOLS.md 3.3。
 *
 * 流程：
 *   1. 週日排程的 Claude 透過 MCP 呼叫 `taifex_weekly_review`（唯讀）看這一週的狀態。
 *   2. 它用 `preview_taifex_review` → `commit_taifex_review` 存一份週檢討 + 調整提案到 `taifex_reviews/{週日日期}`。
 *      **這一步不會改任何參數**，只是一份待核准的提案（並推播 Telegram）。
 *   3. owner 在 App「台指期模擬 → 週檢討」按「套用」（applyTaifexReview）才寫進
 *      `taifex_tuning/current` 與 `taifex_configs/default`；可以「退回」或「還原上一次套用」。
 *
 * 資料：
 *   taifex_tuning/current   { version, params, weights, tech, reviewId, updatedAt, history }
 *   taifex_reviews/{weekEnd} { weekStart, weekEnd, status, summary, findings, algorithmIdeas, prUrl, week, proposal, before, ... }
 * 兩個 collection 前端唯讀（Rules write: false）。
 */

var TAIFEX_TUNING_PATH_ = 'taifex_tuning/current';
var TAIFEX_TUNING_CACHE_KEY_ = 'taifex-tuning-v1';
var TAIFEX_REVIEW_TEXT_MAX_ = 1500;
var TAIFEX_REVIEW_PR_PATTERN_ = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

// -------- 調校值 --------

/** 目前生效的調校值（驗過範圍）。盤中每 5 分鐘會讀，所以在 CacheService 放 10 分鐘；套用 / 還原時清掉。 */
function loadTaifexTuning_() {
  var cache = CacheService.getScriptCache();
  try {
    var hit = cache.get(TAIFEX_TUNING_CACHE_KEY_);
    if (hit) return tfNormalizeTuningDoc_(JSON.parse(hit));
  } catch (cacheErr) { console.warn('loadTaifexTuning_ cache', cacheErr); }
  var tuning = tfNormalizeTuningDoc_(tfStrip_(fsGetDoc_(TAIFEX_TUNING_PATH_)));
  try { cache.put(TAIFEX_TUNING_CACHE_KEY_, JSON.stringify(tuning), 600); } catch (putErr) { console.warn('loadTaifexTuning_ cache put', putErr); }
  return tuning;
}

function tfReviewLoadTuningFresh_() {
  CacheService.getScriptCache().remove(TAIFEX_TUNING_CACHE_KEY_);
  return tfNormalizeTuningDoc_(tfStrip_(fsGetDoc_(TAIFEX_TUNING_PATH_)));
}

/**
 * 主帳戶「現在實際在用」的完整值：提案的 from 以這個為準。
 * 主帳戶不在「Claude 調校」變體時，門檻是它目前那個變體的值、因子權重是內建預設。
 */
function tfReviewBase_(config, tuning, optimized) {
  var defaults = tfTuningDefaults_();
  var onTuned = config.strategyVariant === 'tuned';
  return {
    params: tfParams_(tfVariantParams_(config.strategyVariant, optimized, tfTunedParams_(tuning))),
    weights: onTuned && tuning.weights ? tuning.weights : defaults.weights,
    risk: tfTuneRiskOf_(config),
    tech: tuning.tech || defaults.tech,
  };
}

// -------- 週狀態（MCP 唯讀工具 taifex_weekly_review） --------

function tfReviewValidDate_(value) {
  var s = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && tfDateToStr_(tfStrToDate_(s)) === s ? s : null;
}

function tfReviewQueryRange_(collection, field, start, end, limit) {
  var docs = fsRunQuery_('', {
    from: [{ collectionId: collection }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: field }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: start } } },
      { fieldFilter: { field: { fieldPath: field }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: end } } },
    ] } },
    orderBy: [{ field: { fieldPath: field }, direction: 'ASCENDING' }],
    limit: limit,
  });
  return docs.filter(function (d) { return d && String(d[field] || '') >= start && String(d[field] || '') <= end; });
}

function tfReviewTradeRow_(t) {
  return {
    side: t.side, contracts: t.contracts, openDate: t.openDate, closeDate: t.closeDate,
    entryPrice: t.entryPrice, exitPrice: t.exitPrice, pnlPoints: t.pnlPoints, netPnl: t.netPnl, costs: t.costs,
    holdingBars: t.holdingBars, exitReason: t.exitReason, source: t.source, entryComposite: t.entryComposite,
  };
}

function tfReviewAccountView_(account, week) {
  var win = tfCurveWindow_(account.equityCurve, week.start, week.end, account.initialCapital);
  return {
    equity: Math.round(account.equity),
    initialCapital: account.initialCapital,
    totalReturnPct: account.initialCapital ? tfRound_((account.equity / account.initialCapital - 1) * 100, 2) : null,
    maxDrawdownPct: account.maxDrawdownPct,
    tradeCount: account.tradeCount || 0,
    winCount: account.winCount || 0,
    startedAt: account.startDate || null,
    week: win,
  };
}

function tfReviewSummaryRow_(r) {
  return {
    weekEnd: r.weekEnd, status: r.status, summary: String(r.summary || '').slice(0, 300),
    changes: r.proposal ? tfTuneDiffLines_(r.proposal.diff) : [],
    weekPnl: r.week ? r.week.pnl : null, weekPct: r.week ? r.week.pct : null,
  };
}

function tfReviewRecent_(limit) {
  return fsRunQuery_('', {
    from: [{ collectionId: 'taifex_reviews' }],
    orderBy: [{ field: { fieldPath: 'weekEnd' }, direction: 'DESCENDING' }],
    limit: limit,
  }).map(tfStrip_).sort(function (a, b) { return String(b.weekEnd).localeCompare(String(a.weekEnd)); }).slice(0, limit);
}

/** 一週的完整狀態。args: { weekEnd?: yyyy-MM-dd（那一週裡的任何一天；預設今天） } */
function buildTaifexWeekReview_(args) {
  args = args || {};
  var today = tfToday_();
  var ref = args.weekEnd ? tfReviewValidDate_(args.weekEnd) : today;
  if (!ref) return { error: 'weekEnd must be yyyy-MM-dd' };
  var week = tfWeekRange_(ref);
  var config = loadTaifexConfig_();
  var tuning = tfReviewLoadTuningFresh_();
  var optDoc = tfStrip_(fsGetDoc_(TAIFEX_OPT_PATH_));
  var optimized = optDoc && optDoc.best && optDoc.best.params ? optDoc.best.params : null;
  var account = loadTaifexAccount_();
  if (!account) return { error: '台指期虛擬帳戶尚未建立（先在 App 的台指期模擬頁回補歷史資料）' };

  var trades = tfReviewQueryRange_('taifex_paper_trades', 'closeDate', week.start, week.end, 300).map(tfStrip_);
  var byAccount = {};
  trades.forEach(function (t) {
    var id = t.accountId || TAIFEX_ACCOUNT_ID_;
    (byAccount[id] || (byAccount[id] = [])).push(t);
  });
  var mainTrades = (byAccount[TAIFEX_ACCOUNT_ID_] || []).filter(function (t) { return (t.epoch || 1) === (account.epoch || 1); });
  var base = tfReviewBase_(config, tuning, optimized);

  var signals = tfReviewQueryRange_('taifex_signals', 'date', week.start, week.end, 10).map(function (s) {
    var factors = {};
    Object.keys(s.factors || {}).forEach(function (k) { factors[k] = s.factors[k] ? s.factors[k].score : null; });
    return {
      date: s.date, close: s.close, composite: s.composite, quantScore: s.quantScore, sentimentAdj: s.sentimentAdj,
      coverage: s.coverage, trending: s.trending, adx14: s.indicators ? s.indicators.adx14 : null, atr20: s.indicators ? s.indicators.atr20 : null,
      factors: factors, desired: s.desired || null, decisionReasons: s.decisionReasons || [], eventRisk: !!s.eventRisk,
      sentiment: s.sentiment ? { sentiment: s.sentiment.sentiment, confidence: s.sentiment.confidence } : null,
      position: s.position ? { side: s.position.side, contracts: s.position.contracts } : null,
    };
  });

  var variants = Object.keys(TAIFEX_VARIANTS).map(function (key) {
    var acc = loadTaifexAccountAt_(tfVariantAccountId_(key));
    if (!acc) return { key: key, label: TAIFEX_VARIANTS[key].label, missing: true };
    var view = tfReviewAccountView_(acc, week);
    return {
      key: key, label: TAIFEX_VARIANTS[key].label, isMainVariant: key === config.strategyVariant, params: acc.params || null,
      equity: view.equity, totalReturnPct: view.totalReturnPct, maxDrawdownPct: view.maxDrawdownPct, tradeCount: view.tradeCount,
      weekPnl: view.week.pnl, weekPct: view.week.pct,
      weekTrades: tfTradeStats_((byAccount[tfVariantAccountId_(key)] || []).filter(function (t) { return (t.epoch || 1) === (acc.epoch || 1); })),
    };
  });

  var mainView = tfReviewAccountView_(account, week);
  var out = {
    today: today,
    week: week,
    note: '日線波段每天收盤後算訊號、隔天開盤成交；一週只有幾根 K 棒，單週輸贏的統計意義很低。調整要看多週趨勢與回測，不要只因為一週虧損就改參數。',
    main: {
      product: account.product || config.product, mode: config.mode,
      variant: config.strategyVariant, variantLabel: (TAIFEX_VARIANTS[config.strategyVariant] || {}).label || config.strategyVariant,
      params: base.params, weights: base.weights, risk: base.risk,
      equity: mainView.equity, initialCapital: mainView.initialCapital, totalReturnPct: mainView.totalReturnPct,
      maxDrawdownPct: mainView.maxDrawdownPct, tradeCount: mainView.tradeCount, winCount: mainView.winCount,
      halted: !!account.halted, haltReason: account.haltReason || null,
      position: tfPositionSnapshot_(account.position),
      pending: account.pending ? { target: account.pending.target, contracts: account.pending.contracts, source: account.pending.source } : null,
      week: mainView.week,
      weekTrades: mainTrades.map(tfReviewTradeRow_),
      weekTradeStats: tfTradeStats_(mainTrades),
    },
    signals: signals,
    variants: variants,
  };

  if (optDoc) {
    out.optimization = {
      generatedAt: optDoc.generatedAt || null, trainFrom: optDoc.trainFrom, trainTo: optDoc.trainTo, testFrom: optDoc.testFrom, testTo: optDoc.testTo,
      best: optDoc.best || null, baseline: optDoc.baseline || null, adopt: !!optDoc.adopt, stability: optDoc.stability,
      suggestedRiskPct: optDoc.suggestedRiskPct, fullPeriod: optDoc.fullPeriod || null,
      topVariants: (optDoc.variants || []).slice(0, 5),
      bestParamsHistory: (optDoc.history || []).slice(-8),
      note: 'walk-forward：以樣本內選參數、看樣本外表現。stability 是樣本內 / 外報酬的排名相關係數，低於 0.3 代表參數不穩定（容易過擬合）。',
    };
  }
  var bt = tfStrip_(fsGetDoc_('taifex_backtests/latest'));
  if (bt && bt.variants) {
    out.backtest = { from: bt.from, to: bt.to, bars: bt.bars };
    ['full', 'trendOnly', 'buyHold'].forEach(function (k) {
      out.backtest[k] = bt.variants[k] ? bt.variants[k].metrics : null;
    });
  }

  var techState = tfStrip_(fsGetDoc_(TAIFEX_TECH_PATH_));
  if (techState && techState.bots) {
    var techTrades = tfStrip_(fsGetDoc_(TAIFEX_TECH_TRADES_PATH_)) || {};
    var bots = {};
    Object.keys(techState.bots).forEach(function (id) {
      var b = techState.bots[id];
      bots[id] = { intervalMin: b.interval, realized: b.realized, maxDrawdown: b.maxDrawdown, checks: b.checks, stats: b.stats, entryBuckets: b.buckets };
    });
    out.tech = {
      note: '盤中技術模擬：四個監控頻率（5 / 15 / 30 / 60 分）的機器人，日盤 + 夜盤，不留倉過時段。entryBuckets 是「開盤後多久進場」的分段（d1–d4 日盤、n1–n4 夜盤）。',
      startDate: techState.startDate || null, product: techState.product || null, contracts: techState.contracts || null,
      rules: base.tech,
      allTime: bots,
      week: tfTechWeekStats_(Array.isArray(techTrades.trades) ? techTrades.trades.filter(function (t) { return (t.epoch || 1) === (techState.epoch || 1); }) : [], week.start, week.end),
    };
  }

  out.tuning = {
    version: tuning.version,
    appliedReviewId: tuning.reviewId,
    current: base,
    defaults: tfTuningDefaults_(),
    bounds: TAIFEX_TUNING_BOUNDS,
    how: '要提調整：preview_taifex_review 的 changes 只放要改的 key（params / weights / risk / tech）。提案要 owner 在 App 核准才生效。',
  };
  out.recentReviews = tfReviewRecent_(6).map(tfReviewSummaryRow_);
  return out;
}

// -------- 提案（MCP 寫入工具 preview_taifex_review / commit_taifex_review） --------

function tfReviewText_(value, max) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function tfReviewList_(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return [];
  return value.map(function (v) { return tfReviewText_(v, maxChars); }).filter(Boolean).slice(0, maxItems);
}

/**
 * 驗證一份週檢討 + 調整提案，回傳要寫入的文件（不寫入）。
 * args: { weekEnd?, summary, findings?, algorithmIdeas?, prUrl?, rationale?, changes? }
 * 回 { review, warnings } 或 { error, errors }
 */
function tfBuildReviewDoc_(args) {
  args = args || {};
  var today = tfToday_();
  var ref = args.weekEnd ? tfReviewValidDate_(args.weekEnd) : today;
  if (!ref) return { error: 'weekEnd must be yyyy-MM-dd' };
  var week = tfWeekRange_(ref);
  if (week.start > today) return { error: 'that week has not started yet' };
  var summary = tfReviewText_(args.summary, TAIFEX_REVIEW_TEXT_MAX_);
  if (summary.length < 10) return { error: 'summary is required (what happened this week and why, in Traditional Chinese)' };
  var prUrl = tfReviewText_(args.prUrl, 200);
  if (prUrl && !TAIFEX_REVIEW_PR_PATTERN_.test(prUrl)) return { error: 'prUrl must be a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<n>)' };

  var existing = tfStrip_(fsGetDoc_('taifex_reviews/' + week.end));
  if (existing && existing.status === 'applied') {
    return { error: 'the review for week ' + week.end + ' has already been applied by the owner; it cannot be replaced. Wait for next week.' };
  }

  var config = loadTaifexConfig_();
  var tuning = tfReviewLoadTuningFresh_();
  var optimized = loadTaifexOptimizedParams_();
  var base = tfReviewBase_(config, tuning, optimized);
  var account = loadTaifexAccount_();
  var warnings = [];
  var proposal = null;
  var hasChanges = args.changes && typeof args.changes === 'object' && Object.keys(args.changes).length > 0;
  if (hasChanges) {
    var res = tfProposeTuning_(args.changes, base);
    if (res.errors.length) return { error: 'changes rejected: ' + res.errors.join('；'), errors: res.errors };
    if (!res.diff.length) warnings.push('changes 與目前的值相同，這份檢討會存成「不調整」');
    else {
      var rationale = tfReviewText_(args.rationale, TAIFEX_REVIEW_TEXT_MAX_);
      if (rationale.length < 10) return { error: 'rationale is required when proposing changes (why these values, what evidence)' };
      var sections = tfTuneSections_(res.diff);
      var daily = sections.indexOf('params') >= 0 || sections.indexOf('weights') >= 0;
      proposal = {
        rationale: rationale,
        sections: sections,
        diff: res.diff,
        proposed: res.proposed,
        base: base,
        mainVariant: config.strategyVariant,
        switchVariant: daily && config.strategyVariant !== 'tuned',
        backtest: null,
      };
      if (daily || sections.indexOf('risk') >= 0) {
        var bars = loadTaifexBars_();
        var rawConfig = tfStrip_(fsGetDoc_(TAIFEX_CONFIG_PATH_)) || {};
        var nextConfig = tfTuneCopy_(rawConfig);
        Object.keys(res.proposed.risk).forEach(function (k) { nextConfig[k] = res.proposed.risk[k]; });
        var currentParams = tfTuneCopy_(base.params);
        currentParams.weights = base.weights;
        var nextParams = tfTuneCopy_(res.proposed.params);
        nextParams.weights = res.proposed.weights;
        var cmp = tfCompareTuning_(bars, { params: currentParams, config: rawConfig }, { params: nextParams, config: nextConfig });
        if (cmp) {
          proposal.backtest = cmp;
          warnings = warnings.concat(cmp.warnings);
        } else warnings.push('日 K 不足，無法回測對照');
      }
      if (sections.indexOf('tech') >= 0) warnings.push('盤中技術模擬沒有歷史回測（5 分 K 只保留約 4 個交易日），調整後要靠之後幾週的實際模擬結果驗證');
    }
  }

  var review = {
    weekStart: week.start,
    weekEnd: week.end,
    status: proposal ? 'proposed' : 'no_change',
    summary: summary,
    findings: tfReviewList_(args.findings, 8, 300),
    algorithmIdeas: tfReviewList_(args.algorithmIdeas, 6, 400),
    prUrl: prUrl || null,
    week: account ? (function () {
      var win = tfCurveWindow_(account.equityCurve, week.start, week.end, account.initialCapital);
      return { pnl: win.pnl, pct: win.pct, days: win.days, endEquity: win.endEquity, maxDrawdownPct: win.maxDrawdownPct, indexChangePct: win.indexChangePct };
    })() : null,
    proposal: proposal,
    modelVersion: TAIFEX_MODEL_VERSION,
    techVersion: TAIFEX_TECH_VERSION,
  };
  return { review: review, warnings: warnings, replaces: existing ? existing.status : null };
}

/** 把驗過的提案寫進 taifex_reviews（覆蓋同一週尚未套用的那一份）並推播 */
function tfSaveReview_(review, ctx) {
  var existing = tfStrip_(fsGetDoc_('taifex_reviews/' + review.weekEnd));
  if (existing && existing.status === 'applied') return { error: 'the review for week ' + review.weekEnd + ' has already been applied' };
  var doc = tfTuneCopy_(review);
  doc.createdAt = new Date();
  doc.source = 'mcp';
  doc.client = String((ctx && ctx.client) || 'unknown').slice(0, 60);
  doc.decidedAt = null;
  doc.before = null;
  fsSetDoc_('taifex_reviews/' + review.weekEnd, doc, false);
  try { notifyTaifexReview_(doc); } catch (err) { console.error('notifyTaifexReview_', err); }
  return { ok: true, reviewId: review.weekEnd, status: doc.status };
}

function notifyTaifexReview_(review) {
  var lines = ['【台指期模擬｜週檢討】' + review.weekStart + ' – ' + review.weekEnd];
  if (review.week) {
    lines.push('本週損益 ' + tfSigned_(review.week.pnl) + ' 元（' + (review.week.pct >= 0 ? '+' : '') + review.week.pct + '%）'
      + (review.week.indexChangePct === null ? '' : '｜指數 ' + (review.week.indexChangePct >= 0 ? '+' : '') + review.week.indexChangePct + '%'));
  }
  lines.push(review.summary.slice(0, 500));
  if (review.proposal) {
    lines.push('', '調整提案（尚未生效）：');
    lines = lines.concat(tfTuneDiffLines_(review.proposal.diff).map(function (l) { return '・' + l; }));
    var bt = review.proposal.backtest;
    if (bt && bt.current.outOfSample && bt.proposed.outOfSample) {
      lines.push('樣本外報酬 ' + bt.current.outOfSample.totalReturnPct + '% → ' + bt.proposed.outOfSample.totalReturnPct + '%｜回撤 '
        + bt.current.outOfSample.maxDrawdownPct + '% → ' + bt.proposed.outOfSample.maxDrawdownPct + '%');
    }
    lines.push('到 App「台指期模擬 → 週檢討」核准後才會套用。');
  } else lines.push('', '這週不建議調整參數。');
  if (review.prUrl) lines.push('演算法調整 PR：' + review.prUrl);
  return sendNotification_('taifex', lines.join('\n'));
}

// -------- owner 在 App 的操作 --------

function tfReviewAudit_(authResult, action, reviewId, summary) {
  try {
    fsAddDoc_('audit_logs', {
      userId: (authResult && authResult.uid) || '', timestamp: new Date(), scope: 'taifex', action: action,
      entityId: String(reviewId || ''), summary: String(summary || '').slice(0, 300),
    });
  } catch (err) { console.warn('tfReviewAudit_', err); }
}

function tfReviewWrite_(path, data, merge) {
  var write = { update: { name: fsDocumentName_(path), fields: encodeFields_(data) } };
  if (merge) write.updateMask = { fieldPaths: Object.keys(data) };
  return write;
}

function tfReviewHistory_(tuningDoc, entry) {
  var history = tuningDoc && Array.isArray(tuningDoc.history) ? tuningDoc.history : [];
  return history.concat([entry]).slice(-TAIFEX_TUNING_HISTORY_MAX);
}

/** 套用一份提案。body: { id }（週日日期） */
function applyTaifexReview(body, authResult) {
  var id = tfReviewValidDate_(body && body.id);
  if (!id) return { ok: false, error: '缺少檢討 id' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: '另一個台指期排程正在執行，請稍後再試' };
  try {
    var review = tfStrip_(fsGetDoc_('taifex_reviews/' + id));
    if (!review) return { ok: false, error: '找不到這份檢討' };
    if (review.status !== 'proposed' || !review.proposal || !review.proposal.proposed) return { ok: false, error: '這份檢討沒有待核准的提案' };

    var config = loadTaifexConfig_();
    var rawTuning = tfStrip_(fsGetDoc_(TAIFEX_TUNING_PATH_)) || {};
    var tuning = tfNormalizeTuningDoc_(rawTuning);
    var base = tfReviewBase_(config, tuning, loadTaifexOptimizedParams_());
    var sections = review.proposal.sections || [];
    // 以「現在」的值為基準重新驗一次（提案之後設定可能被改過；也擋掉被手動改壞的文件）
    var changes = {};
    sections.forEach(function (s) { changes[s] = review.proposal.proposed[s]; });
    var res = tfProposeTuning_(changes, base);
    if (res.errors.length) return { ok: false, error: '提案內容不合法：' + res.errors.join('；') };

    var daily = sections.indexOf('params') >= 0 || sections.indexOf('weights') >= 0;
    var nextTuning = {
      version: tuning.version + 1,
      params: daily ? res.proposed.params : tuning.params,
      weights: daily ? res.proposed.weights : tuning.weights,
      tech: sections.indexOf('tech') >= 0 ? res.proposed.tech : tuning.tech,
      reviewId: id,
      updatedAt: new Date(),
      history: tfReviewHistory_(rawTuning, { date: tfToday_(), action: 'apply', reviewId: id, changes: tfTuneDiffLines_(res.diff) }),
    };
    var configPatch = {};
    if (sections.indexOf('risk') >= 0) TAIFEX_TUNING_RISK_KEYS.forEach(function (k) { configPatch[k] = res.proposed.risk[k]; });
    if (daily) configPatch.strategyVariant = 'tuned';
    var before = {
      tuning: { params: tuning.params, weights: tuning.weights, tech: tuning.tech },
      risk: tfTuneRiskOf_(config),
      strategyVariant: config.strategyVariant,
    };
    var writes = [
      tfReviewWrite_(TAIFEX_TUNING_PATH_, nextTuning, false),
      tfReviewWrite_('taifex_reviews/' + id, { status: 'applied', decidedAt: new Date(), before: before, appliedDiff: res.diff }, true),
    ];
    if (Object.keys(configPatch).length) writes.push(tfReviewWrite_(TAIFEX_CONFIG_PATH_, configPatch, true));
    fsBatchWrite_(writes);
    CacheService.getScriptCache().remove(TAIFEX_TUNING_CACHE_KEY_);
    tfReviewAudit_(authResult, 'apply-review', id, '套用台指期週檢討 ' + id + '：' + tfTuneDiffLines_(res.diff).join('、'));
    return { ok: true, version: nextTuning.version, switchedVariant: daily && config.strategyVariant !== 'tuned', changes: tfTuneDiffLines_(res.diff) };
  } finally {
    lock.releaseLock();
  }
}

/** 退回一份提案（不套用）。body: { id } */
function rejectTaifexReview(body, authResult) {
  var id = tfReviewValidDate_(body && body.id);
  if (!id) return { ok: false, error: '缺少檢討 id' };
  var review = tfStrip_(fsGetDoc_('taifex_reviews/' + id));
  if (!review) return { ok: false, error: '找不到這份檢討' };
  if (review.status !== 'proposed') return { ok: false, error: '這份檢討沒有待核准的提案' };
  fsSetDoc_('taifex_reviews/' + id, { status: 'rejected', decidedAt: new Date() }, true);
  tfReviewAudit_(authResult, 'reject-review', id, '退回台指期週檢討 ' + id + ' 的調整提案');
  return { ok: true };
}

/** 還原最近一次套用（只能還原一層）。body: { id } 必須是目前生效的那一份 */
function revertTaifexTuning(body, authResult) {
  var id = tfReviewValidDate_(body && body.id);
  if (!id) return { ok: false, error: '缺少檢討 id' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: '另一個台指期排程正在執行，請稍後再試' };
  try {
    var rawTuning = tfStrip_(fsGetDoc_(TAIFEX_TUNING_PATH_)) || {};
    if (rawTuning.reviewId !== id) return { ok: false, error: '只能還原最近一次套用的檢討' };
    var review = tfStrip_(fsGetDoc_('taifex_reviews/' + id));
    if (!review || review.status !== 'applied' || !review.before) return { ok: false, error: '這份檢討沒有可以還原的紀錄' };
    var before = review.before;
    var prev = tfNormalizeTuningDoc_(before.tuning || {});
    var nextTuning = {
      version: (Number(rawTuning.version) || 0) + 1,
      params: prev.params,
      weights: prev.weights,
      tech: prev.tech,
      reviewId: null,
      updatedAt: new Date(),
      history: tfReviewHistory_(rawTuning, { date: tfToday_(), action: 'revert', reviewId: id, changes: [] }),
    };
    var sections = (review.proposal && review.proposal.sections) || [];
    var configPatch = {};
    if (sections.indexOf('risk') >= 0 && before.risk) {
      TAIFEX_TUNING_RISK_KEYS.forEach(function (k) { if (before.risk[k] !== undefined) configPatch[k] = before.risk[k]; });
    }
    var daily = sections.indexOf('params') >= 0 || sections.indexOf('weights') >= 0;
    if (daily && TAIFEX_VARIANTS[before.strategyVariant]) configPatch.strategyVariant = before.strategyVariant;
    var writes = [
      tfReviewWrite_(TAIFEX_TUNING_PATH_, nextTuning, false),
      tfReviewWrite_('taifex_reviews/' + id, { status: 'reverted', revertedAt: new Date() }, true),
    ];
    if (Object.keys(configPatch).length) writes.push(tfReviewWrite_(TAIFEX_CONFIG_PATH_, configPatch, true));
    fsBatchWrite_(writes);
    CacheService.getScriptCache().remove(TAIFEX_TUNING_CACHE_KEY_);
    tfReviewAudit_(authResult, 'revert-tuning', id, '還原台指期週檢討 ' + id + ' 套用的調整');
    return { ok: true, version: nextTuning.version };
  } finally {
    lock.releaseLock();
  }
}
