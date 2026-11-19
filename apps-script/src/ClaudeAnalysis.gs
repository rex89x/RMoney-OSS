/**
 * Claude 手動分析（只在使用者按下「確認執行」才會呼叫 Claude，不走任何排程）。
 *
 * 兩段式：
 *   action=estimateClaudeAnalysis { kind, month?, tripId?, focus? }  → 用免費的 count_tokens 估價
 *   action=runClaudeAnalysis      { kind, month?, tripId?, focus?, confirmed: true }
 *
 * 2026-11 起改成「Claude 自己找資料」：不再由後端把整包資料塞進 prompt，而是只給任務說明 +
 * HubTools.gs 的唯讀工具，Claude 依任務決定要查哪些聚合 / 明細（claudeAgentLoop_）。
 * 好處：只送用得到的資料、可以追查可疑項目的明細、同一套工具也透過 MCP 給外部 client 用（Mcp.gs）。
 *
 * kind：
 *   monthlyReview      月度財務回顧
 *   subscriptionAudit  固定支出 / 訂閱健檢
 *   portfolioReview    投資組合健檢
 *   transactionCleanup 記帳品質檢查
 *   tripReview         旅遊計畫檢視（預算、行程節奏、花費）
 *
 * 費用護欄：工具輪數、累計 input tokens、執行時間都有上限（CLAUDE_ANALYSIS_LIMITS_），
 * 到上限就要求 Claude 以手上的資料完成報告。結果只回傳 Markdown，不寫 Firestore。
 */

var CLAUDE_ANALYSIS_KINDS_ = {
  monthlyReview: { title: '月度財務回顧', effort: 'medium', maxTokens: 12000, estOutput: [3000, 9000], estRounds: [2, 4] },
  subscriptionAudit: { title: '固定支出 / 訂閱健檢', effort: 'medium', maxTokens: 10000, estOutput: [2500, 8000], estRounds: [2, 4] },
  portfolioReview: { title: '投資組合健檢', effort: 'medium', maxTokens: 12000, estOutput: [3000, 9000], estRounds: [2, 4] },
  transactionCleanup: { title: '記帳品質檢查', effort: 'low', maxTokens: 12000, estOutput: [2500, 8000], estRounds: [2, 4] },
  tripReview: { title: '旅遊計畫檢視', effort: 'medium', maxTokens: 12000, estOutput: [3000, 9000], estRounds: [2, 5] },
};

/** 每次分析的硬上限：工具輪數 / 累計 input tokens / 不再開新工具輪的時間點（Apps Script 6 分鐘上限內） */
var CLAUDE_ANALYSIS_LIMITS_ = { maxRounds: 6, maxInputTokens: 150000, deadlineMs: 200000 };
/** 估價用：每一輪工具查詢平均帶回多少 tokens 的資料（經驗值） */
var CLAUDE_ANALYSIS_EST_TOOL_TOKENS_ = [1500, 6000];

function claudeAnalysisSystem_() {
  return [
    '你是 owner 的個人財務與旅遊顧問，資料來源是 Personal Hub（他自己的記帳 / 投資 / 旅遊規劃系統）。',
    '今天是 ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd') + '（Asia/Taipei），金額單位是新台幣，除非另外標示。',
    '你手上沒有任何資料，必須用提供的工具自己查：先想清楚這個任務需要哪些數字，用聚合工具看全貌，再針對重要或可疑的部分查明細。'
      + '可以在同一輪平行呼叫多個工具。只查任務需要的資料，不要把所有工具都跑一遍；不確定資料在哪裡時先呼叫 hub_catalog。',
    '只根據查到的資料下結論，沒有查到的不要編造；推論要說明依據，資料不足就直說缺什麼。',
    '用繁體中文、Markdown 輸出：先 3 句以內的重點摘要，再分段（## 標題）列出發現與具體可執行的建議。',
    '金額寫成 NT$1,234；不要使用 emoji；不要輸出 raw HTML；不要提供買賣特定股票的指示，只做風險與配置的觀察。',
  ].join('\n');
}

function claudeAnalysisMonth_(value) {
  var month = String(value || '');
  if (/^\d{4}-\d{2}$/.test(month)) return month;
  // 預設上個月（當月資料還不完整）
  var parts = Utilities.formatDate(new Date(), TZ, 'yyyy-M').split('-');
  var d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 2, 15));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM');
}

function claudePrevMonth_(month) {
  var parts = month.split('-');
  return Utilities.formatDate(new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 2, 15)), 'UTC', 'yyyy-MM');
}

/** 各 kind 的任務說明（只描述要回答什麼，資料由 Claude 自己用工具查） */
function claudeAnalysisTask_(kind, body) {
  if (kind === 'monthlyReview') {
    var month = claudeAnalysisMonth_(body.month);
    return '請做 ' + month + ' 的月度財務回顧（比較對象是前一個月 ' + claudePrevMonth_(month) + '）：收支與儲蓄率、'
      + '和上個月相比變化最大的類別（查明細說明可能原因）、大額或不尋常的支出、預算執行狀況，'
      + '最後給 3 到 5 個下個月可以執行的具體建議。';
  }
  if (kind === 'subscriptionAudit') {
    return '請檢查我的固定支出與訂閱：對照已設定的週期範本 / 訂閱，以及近 3 個月實際重複出現的支出，'
      + '列出每月固定成本總額估計、疑似訂閱或重複扣款但沒有設定成週期的項目、金額有上漲的項目、'
      + '可能可以取消或降級的項目（依可省金額排序，附年化金額）。';
  }
  if (kind === 'portfolioReview') {
    return '請做投資組合健檢：單一持股與產業集中度、台美股與現金配置、虧損部位與獲利部位的結構、'
      + '投資部位占淨值比例、近期市值走勢，並指出需要留意的風險與可以考慮的再平衡方向（不要給個股買賣指示）。'
      + '如果有設定投資 / 退休規劃，一併檢視進度。';
  }
  if (kind === 'transactionCleanup') {
    return '請檢查近 60 天的記帳品質：疑似分類錯誤（附建議的類別 key，類別清單用 list_records 的 categories 查）、'
      + '疑似重複記帳、備註太模糊難以辨識的項目、金額異常的項目。交易較多時用 offset 翻頁看完。'
      + '用 Markdown 表格列出（日期、金額、備註、問題、建議），最多 40 列，最後總結常見的記帳習慣問題。';
  }
  var tripId = String(body.tripId || '');
  var target = tripId && hubValidId_(tripId)
    ? '請檢視旅程 tripId = ' + tripId + ' 的旅遊計畫'
    : '請檢視我接下來的旅遊計畫（先列出旅程，挑規劃中或進行中的；若有多個以最近出發的為主，其餘簡短帶過）';
  return target + '：預算是否合理（對照已記帳的花費與行程的預估花費）、每天行程的節奏與動線有沒有太趕或有空檔、'
    + '還缺哪些準備（住宿、交通、票券等看行程與花費是否已涵蓋）、出發前該留意的財務面事項（匯率、現金、刷卡），'
    + '最後給具體的調整建議。';
}

/** 依 kind 組出 Claude request（estimate 與 run 共用，確保估價的就是要送的） */
function claudeAnalysisRequest_(body) {
  body = body || {};
  var kind = String(body.kind || '');
  var meta = CLAUDE_ANALYSIS_KINDS_[kind];
  if (!meta) throw new Error('unknown analysis kind: ' + kind);
  var task = claudeAnalysisTask_(kind, body);
  var focus = String(body.focus || '').trim().slice(0, 300);
  if (focus) task += '\n\n我特別想知道：' + focus;
  return {
    kind: kind,
    title: meta.title,
    meta: meta,
    opts: {
      feature: 'analysis:' + kind,
      tier: 'default',
      effort: meta.effort,
      maxTokens: meta.maxTokens,
      system: claudeAnalysisSystem_(),
      tools: hubToolDefs_(),
      messages: [{ role: 'user', content: task }],
    },
  };
}

/**
 * 估價。Claude 會自己決定查幾輪，所以 input 只能給區間：
 *   每一輪都會重送「基礎 prompt（system + 工具定義 + 任務）」加上前面累積的工具結果。
 *   基礎 prompt 用免費的 count_tokens 精算；工具結果用經驗值估。
 * 不計 prompt cache 折扣（實際通常更便宜）；上限以 CLAUDE_ANALYSIS_LIMITS_ 計。
 */
function claudeAnalysisEstimateTokens_(baseTokens, meta) {
  var inputFor = function (rounds, perRound) {
    // 第 i 次呼叫（共 rounds + 1 次）帶 base + 前 i 輪的工具結果
    var calls = rounds + 1;
    return Math.round(baseTokens * calls + perRound * (rounds * (rounds + 1) / 2));
  };
  var limits = CLAUDE_ANALYSIS_LIMITS_;
  return {
    inputRange: [inputFor(meta.estRounds[0], CLAUDE_ANALYSIS_EST_TOOL_TOKENS_[0]), inputFor(meta.estRounds[1], CLAUDE_ANALYSIS_EST_TOOL_TOKENS_[1])],
    // 超過 maxInputTokens 後還會有最後一次作答呼叫，抓 1.5 倍；output 最多 maxRounds + 1 次回應，實務上只有最後一次長
    maxInput: Math.round(limits.maxInputTokens * 1.5),
    maxOutput: meta.maxTokens * 2,
  };
}

function estimateClaudeAnalysis(body) {
  try {
    if (!claudeConfigured_()) return { ok: false, error: 'ANTHROPIC_API_KEY 尚未設定' };
    var req = claudeAnalysisRequest_(body);
    var model = claudeModelFor_('default');
    var baseTokens = claudeCountTokens_(Object.assign({}, req.opts, { model: model }))
      || Math.ceil(JSON.stringify([req.opts.system, req.opts.tools, req.opts.messages]).length / 2);
    var est = claudeAnalysisEstimateTokens_(baseTokens, req.meta);
    var cost = function (inputTokens, outputTokens) {
      return aiEstimateClaudeCostUSD_(model, {
        inputTokens: inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: outputTokens, webSearchRequests: 0,
      });
    };
    var uid = aiOwnerId_();
    var config = aiOwnerConfig_(uid);
    var cycle = uid ? aiCurrentCycleSpend_(uid, config) : { spentUSD: 0, creditUSD: aiCreditUSD_(config) };
    return {
      ok: true,
      kind: req.kind,
      title: req.title,
      model: model,
      inputTokens: baseTokens,
      inputTokensRange: est.inputRange,
      outputTokensRange: req.meta.estOutput,
      costUSDRange: [cost(est.inputRange[0], req.meta.estOutput[0]), cost(est.inputRange[1], req.meta.estOutput[1])],
      maxCostUSD: cost(est.maxInput, est.maxOutput),
      maxRounds: CLAUDE_ANALYSIS_LIMITS_.maxRounds,
      cycleSpentUSD: cycle.spentUSD,
      creditUSD: cycle.creditUSD,
    };
  } catch (err) {
    console.error('[estimateClaudeAnalysis]', err);
    return { ok: false, error: String(err && err.message || err) };
  }
}

function runClaudeAnalysis(body) {
  try {
    if (!body || body.confirmed !== true) return { ok: false, error: '需要先確認費用才能執行' };
    var req = claudeAnalysisRequest_(body);
    var res = claudeAgentLoop_(Object.assign({}, req.opts, {
      runTool: hubCallTool_,
      maxRounds: CLAUDE_ANALYSIS_LIMITS_.maxRounds,
      maxInputTokens: CLAUDE_ANALYSIS_LIMITS_.maxInputTokens,
      deadlineMs: CLAUDE_ANALYSIS_LIMITS_.deadlineMs,
    }));
    var markdown = res.text.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    if (!markdown) return { ok: false, error: 'Claude 沒有回傳內容' };
    return {
      ok: true,
      kind: req.kind,
      title: req.title,
      markdown: markdown,
      truncated: res.truncated,
      model: res.model,
      inputTokens: res.usage.inputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens,
      outputTokens: res.usage.outputTokens,
      costUSD: res.costUSD,
      rounds: res.rounds,
      // 只回工具名稱與參數（讓使用者看到 Claude 查了什麼），不回工具結果
      toolCalls: res.toolCalls,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[runClaudeAnalysis]', err);
    return { ok: false, error: String(err && err.message || err) };
  }
}
