/**
 * Telegram bidirectional bot — 透過 webhook 接收訊息，依語法快速記帳
 *
 * 設置：
 *   1. 在 Apps Script 部署後拿到 web app URL
 *   2. setupTelegramWebhook() 一次性註冊：
 *      curl https://api.telegram.org/bot{TOKEN}/setWebhook?url={WEBAPP_URL}?action=tgWebhook&secret={TG_WEBHOOK_SECRET}
 *      （或直接呼叫 setupTelegramWebhook_('webapp_url') 從 Apps Script 內部）
 *   3. 在 Script Properties 設 TG_WEBHOOK_SECRET（任意字串）— 防止他人偽造 webhook
 *   4. 安全機制：訊息必須來自 TG_CHAT_ID 設定的 chat 才會處理
 *
 * 支援語法：
 *   /balance               本月收支總覽
 *   /budget                本月預算進度
 *   /forecast              月底結餘預測
 *   /subs                  訂閱費清單
 *   /goals                 儲蓄目標進度
 *   /paid <pmKey>          標記某張信用卡本期已繳費（pmKey = payment_method doc id）
 *   /scheduled             即將到期的排程支出
 *   /help                  指令清單
 *   午餐 150               記一筆 150 元支出（自由文字）
 *   昨天 星巴克 180 刷玉山   Claude 解析：日期 / 備註 / 金額 / 支付方式 / 類別
 *   USD 12.5 app 訂閱      外幣會用 fx_rates 換算 amountTWD
 *   多行 / 多筆文字         先問要 Claude 轉匯入、產生提示詞、或當一筆記帳（ImportTelegram.gs）
 *   /cancel                清掉進行中的分段 JSON
 *
 * 自由文字先交給Claude（fast tier）做結構化解析；
 * ANTHROPIC_API_KEY 未設或 Claude 呼叫失敗時退回原本的 regex 解析（描述 金額 [類別]）。
 * 記帳成功後會附 inline keyboard：「改類別」「改支付方式」「刪除」，callback 走同一個 webhook。
 * 有對到帳戶（刷玉山 / 用 LINE Pay…）的記帳會同步調整帳戶餘額，與 web / 匯入一致。
 */

function tgWebhook_(e) {
  // 驗證 secret
  var secret = (e && e.parameter && e.parameter.secret) || null;
  var expected = PROP.getProperty('TG_WEBHOOK_SECRET');
  if (!expected || !secretEquals_(secret, expected)) {
    return jsonResponse_({ ok: false, error: 'webhook-unauthorized' });
  }
  var body = parseBody_(e);

  // ── 1. update_id dedup（雙層）──
  // 之前用 ScriptCache 6h TTL，但 Telegram 把卡住的舊 update 排進 pending queue
  // retry，超過 6h 後 cache 失效 → 同一則 /help 在 +6h / +12h / +18h 又被處理一次。
  // 解法：ScriptCache（短期 hot path）+ ScriptProperties 持久化「last update_id」
  // （Telegram 保證 update_id 單調遞增），任何 id <= lastSeen 一律當 retry。
  var updateId = body && body.update_id;
  if (updateId != null) {
    var dupReason = checkAndMarkDup_(updateId);
    if (dupReason) {
      console.log('tgWebhook: dup update_id ' + updateId + ' skipped (' + dupReason + ')');
      return jsonResponse_({ ok: true, skipped: dupReason, updateId: updateId });
    }
  }

  // ── 2. 不再使用 LockService.getScriptLock()：
  // 那個 lock 是 script-wide，會跟 tick_15min / tick_hourly 等排程共用，造成
  // webhook 撞上排程時靜默 skipped: 'busy' → 用戶看不到回覆。
  // update_id dedup 已能保證同一筆 update 只處理一次；不同 update 並行處理是安全的。

  // inline keyboard 回呼（改類別 / 刪除）
  if (body.callback_query) {
    return tgHandleCallback_(body.callback_query, updateId);
  }

  var msg = body.message || body.edited_message || body.channel_post || null;
  if (!msg) return jsonResponse_({ ok: true, skipped: 'no-message' });

  // 過濾 bot 自己的訊息（理論上 Telegram 不會回送，但保險起見）
  if (msg.from && msg.from.is_bot) {
    return jsonResponse_({ ok: true, skipped: 'from-bot' });
  }

  var chatId = String((msg.chat && msg.chat.id) || '');
  var allowedChat = PROP.getProperty('TG_CHAT_ID');
  var text = String(msg.text || '').trim();

  // 共同帳本綁定：`/start {token}` 任何私訊 chat 都可以（token 一次性 + 24h，見 HouseholdTelegram.gs）
  var startMatch = /^\/start(?:@\w+)?\s+([A-Za-z0-9]{1,64})$/.exec(text);
  if (startMatch && msg.chat && msg.chat.type === 'private') {
    try {
      sendTelegramToChat_(chatId, hhTgHandleStart_(chatId, startMatch[1], msg.from));
    } catch (linkErr) {
      console.error('tgWebhook link error', linkErr);
      try { logErrorToFirestore_('tgLink', linkErr, null); } catch (ignoredErr) { console.warn('[TelegramBot:85] ignored', ignoredErr); }
      sendTelegramToChat_(chatId, '連結失敗，請回 RMoney 重新產生連結。');
    }
    return jsonResponse_({ ok: true, updateId: updateId, linked: true });
  }

  if (!allowedChat || chatId !== String(allowedChat)) {
    // 已綁定的共同帳本成員：只開放共同帳本指令（不能用 owner 的記帳 / 查帳）
    if (text && msg.chat && msg.chat.type === 'private') {
      var memberReply = null;
      try { memberReply = hhTgHandleMemberMessage_(chatId, text); } catch (mErr) { console.error('tgWebhook member', mErr); }
      if (memberReply) {
        sendTelegramToChat_(chatId, memberReply);
        return jsonResponse_({ ok: true, updateId: updateId, member: true });
      }
    }
    console.warn('tgWebhook: unauthorized chat', chatId, 'allowed=', allowedChat);
    return jsonResponse_({ ok: true, skipped: 'chat-not-allowed', chatId: chatId });
  }

  // owner chat 若是群組：只有 TG_ALLOWED_USER_IDS 列的 user id 可以記帳 / 查帳（群裡其他人不行）
  if (!tgSenderAllowed_(msg)) {
    console.warn('tgWebhook: sender not allowed', msg.from && msg.from.id);
    return jsonResponse_({ ok: true, skipped: 'sender-not-allowed' });
  }

  // 傳 .json / .txt 檔 = 匯入（owner chat 才會走到這裡）
  if (!text && msg.document) {
    try {
      var docReply = tgImportFromDocument_(msg.document);
      if (docReply !== TG_REPLY_SENT_) sendTelegram(docReply);
    } catch (docErr) {
      console.error('tgWebhook document', docErr);
      try { logErrorToFirestore_('tgImportDocument', docErr, null); } catch (ignoredErr) { console.warn('[TelegramBot:118] ignored', ignoredErr); }
      sendTelegram('檔案匯入失敗：' + String(docErr && docErr.message || docErr).slice(0, 80));
    }
    return jsonResponse_({ ok: true, updateId: updateId, document: true });
  }
  if (!text) return jsonResponse_({ ok: true, skipped: 'no-text' });

  try {
    var reply = handleTgCommand_(text);
    // 自由文字記帳會自己送出帶 keyboard 的訊息，回傳 sentinel 就不再重複送。
    if (reply === TG_REPLY_SENT_) return jsonResponse_({ ok: true, updateId: updateId, sent: 'inline' });
    // safeReply_ 保證 reply 一定是非空字串；萬一未來重構漏掉，再補一個 fallback。
    if (!reply) reply = '指令處理完成（無回應內容）';
    sendTelegram(reply);
    return jsonResponse_({ ok: true, updateId: updateId });
  } catch (err) {
    console.error('tgWebhook handle error', err);
    try { logErrorToFirestore_('tgWebhookHandle', err, { updateId: updateId, text: text }); } catch (ignoredErr) { console.warn('[TelegramBot:135] ignored', ignoredErr); }
    // dedup 已寫 → 即使 sendTelegram 也是「對單一 update 的最後一發」，不會放大 quota loop。
    // 之前刻意拿掉這裡的 sendTelegram，但結果是「指令一壞就完全靜音」，比 loop 更難 debug。
    try {
      sendTelegram('指令處理失敗，原因已寫入 errorLogs：'
        + String(err && err.message || err).slice(0, 80));
    } catch (ignoredErr) { console.warn('[TelegramBot:141] ignored', ignoredErr); }
    return jsonResponse_({ ok: true, error: String(err && err.message || err) });
  }
}

/**
 * 雙層 dedup：
 *   1. ScriptProperties.TG_LAST_UPDATE_ID（單調遞增）— 永久有效，超 6h 也擋得住
 *   2. ScriptCache（21600s）— 同一秒/分內 race 時的補強
 * 任一觸發即視為 retry。回傳 reason 字串（'last-id' / 'cache'）或 null。
 */
function checkAndMarkDup_(updateId) {
  var idNum = parseInt(updateId, 10);
  if (isNaN(idNum)) return null; // 非數字直接放行（理論上不會發生）

  // a) Properties 持久化檢查
  var lastSeenStr = PROP.getProperty('TG_LAST_UPDATE_ID');
  var lastSeen = lastSeenStr ? parseInt(lastSeenStr, 10) : 0;
  if (idNum <= lastSeen) return 'last-id';

  // b) ScriptCache fast path
  var cache = CacheService.getScriptCache();
  var cacheKey = 'tg-update-' + idNum;
  if (cache.get(cacheKey)) return 'cache';

  // 兩層都過 → 標記已看過。Properties 必須是「目前看過的最大值」；race 下落後 update
  // 會被忽略，但 Telegram 對單一 chat 的 update 是 in-order 投遞，影響很小。
  cache.put(cacheKey, '1', 21600);
  if (idNum > lastSeen) {
    PROP.setProperty('TG_LAST_UPDATE_ID', String(idNum));
  }
  return null;
}

/**
 * 緊急重置：把 TG_LAST_UPDATE_ID 清掉（下個 update 視為全新）。
 * 通常配合 tgFlushPendingUpdates() 使用。
 */
function tgResetDedup() {
  PROP.deleteProperty('TG_LAST_UPDATE_ID');
  return { ok: true, cleared: 'TG_LAST_UPDATE_ID' };
}

/**
 * 記錯誤到 Firestore errorLogs 集合 — 取代 catch 內 sendTelegram，避免錯誤迴圈。
 * 失敗時靜默；console 已有原始 stack。
 */
function logErrorToFirestore_(scope, err, ctx) {
  try {
    // 注意：collection 名稱用 snake_case `error_logs`（前端 settings 頁讀的也是這個）
    fsAddDoc_('error_logs', {
      scope: String(scope || ''),
      message: String(err && err.message || err),
      stack: String((err && err.stack) || ''),
      context: ctx ? JSON.stringify(ctx).slice(0, 500) : null,
      createdAt: new Date(),
    });
  } catch (logErr) { console.warn('[logErrorToFirestore_] write failed', logErr); }
}

/**
 * 自我診斷：直接送一段測試訊息，繞過 webhook，驗證 token / chat id / 邏輯有沒有壞。
 * 在 Apps Script 編輯器選 tgSelfTest → 執行。
 */
function tgSelfTest() {
  var token = PROP.getProperty('TG_BOT_TOKEN');
  var chatId = PROP.getProperty('TG_CHAT_ID');
  var secret = PROP.getProperty('TG_WEBHOOK_SECRET');
  var info = {
    hasToken: !!token,
    hasChatId: !!chatId,
    hasSecret: !!secret,
    chatId: chatId,
  };
  // 嘗試直接發訊息（繞過 webhook）
  var send = sendTelegram('[Personal Hub] tgSelfTest — webhook 與其他鏈路正常');
  info.sendDirect = send;
  // 模擬一筆 webhook update
  var fakeUpdate = {
    update_id: 'selftest-' + Date.now(),
    message: {
      from: { id: chatId ? Number(chatId) : 0, is_bot: false },
      chat: { id: chatId ? Number(chatId) : 0 },
      text: '/help',
    },
  };
  // 直接呼叫 handler（注意：這會跳過 secret 驗證以便測試）
  try {
    var msg = fakeUpdate.message;
    var reply = handleTgCommand_(msg.text);
    info.replyPreview = reply ? reply.substring(0, 80) + '…' : null;
    info.handlerOk = true;
  } catch (err) {
    info.handlerOk = false;
    info.handlerError = String(err && err.message || err);
  }
  // 看 webhook 註冊狀態
  if (token) {
    try {
      var resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getWebhookInfo', { muteHttpExceptions: true });
      info.webhookInfo = JSON.parse(resp.getContentText());
    } catch (err) {
      info.webhookInfoError = String(err && err.message || err);
    }
  }
  console.log(JSON.stringify(info, null, 2));
  return info;
}

var TG_REPLY_SENT_ = '__tg_reply_sent__';

function handleTgCommand_(text) {
  // Slash commands — 每個 case 個別 try/catch，單一指令內部 throw 不會吞掉
  // 整條 webhook 流程；發給用戶的是固定短文字，不帶 raw err（避免 quota / 隱私外洩）。
  if (text.charAt(0) === '/') {
    var parts = text.split(/\s+/);
    var cmd = parts[0].toLowerCase();
    var args = parts.slice(1);
    return safeReply_(cmd, function () {
      switch (cmd) {
        case '/help': return tgHelpReply_();
        case '/balance': return tgBalanceReply_();
        case '/budget': return tgBudgetReply_();
        case '/forecast': return tgForecastReply_();
        case '/subs': return tgSubsReply_();
        case '/goals': return tgGoalsReply_();
        case '/scheduled': return tgScheduledReply_();
        case '/paid': return tgMarkPaidReply_(args.join(' '));
        case '/ask': return tgAskReply_(args.join(' '));
        case '/report': return tgHouseholdReportReply_(true);
        case '/invest': return tgHouseholdReportReply_(false);
        case '/import': return tgImportFromText_(text.slice(cmd.length).trim(), null);
        case '/ai': return tgImportAiFromText_(text.slice(cmd.length).trim());
        case '/prompt':
        case '/p': return tgImportPromptReply_(text.slice(cmd.length).trim());
        case '/cancel': return tgImportCancelPartial_();
        default: return '未知指令：' + cmd + '。輸入 /help 看清單。';
      }
    });
  }
  // 上一則 JSON 被 Telegram 切斷還沒結束 → 這則接上去
  if (tgImportHasPartial_()) {
    return safeReply_('importPartial', function () { return tgImportContinuePartial_(text); });
  }
  // 貼 JSON（{ / [ / ```json 開頭，容許彎引號）= 匯入，不用加 /import
  if (tgLooksLikeImportJson_(text)) {
    return safeReply_('import', function () { return tgImportFromText_(text, null); });
  }
  // 多行 / 多筆：先問要怎麼處理，不要硬當一筆
  if (tgLooksLikeBulkText_(text)) {
    return safeReply_('importChoice', function () { return tgOfferImportChoice_(text); });
  }
  // 自由文字記帳
  return safeReply_('quickEntry', function () { return tgQuickEntry_(text); });
}

function safeReply_(label, fn) {
  try {
    var r = fn();
    if (r == null || r === '') return '指令處理完成（' + label + '，無內容回覆）';
    return r;
  } catch (err) {
    console.error('tgCommand ' + label + ' error', err);
    try { logErrorToFirestore_('tgCommand:' + label, err, null); } catch (ignoredErr) { console.warn('[TelegramBot:304] ignored', ignoredErr); }
    // 帶上原因前 60 字以利 debug；長 stack 不外露（隱私 + Telegram 4096 上限）。
    var msg = String(err && err.message || err).slice(0, 60);
    return '指令處理失敗（' + label + '）：' + msg;
  }
}

function tgHelpReply_() {
  return [
    'Personal Hub Bot 指令：',
    '/balance — 本月收支',
    '/budget — 本月預算進度',
    '/forecast — 月底結餘預測',
    '/subs — 訂閱費清單',
    '/goals — 儲蓄目標',
    '/scheduled — 排程支出',
    '/paid <卡片id> — 標記信用卡本期已繳',
    '/ask <問題> — 用自然語言查帳，例：/ask 上個月餐飲花多少',
    '/report — 共同帳本報告（共同支出 + 共同投資）',
    '/invest — 共同投資現況',
    '/import <JSON> — 匯入 RMoney 匯入格式（記帳 / 股票成交），直接貼 JSON 或傳 .json 檔也可以；彎引號 / 單引號 / 少逗號會自動修，被切成多則會自動接',
    '/ai <原始文字> — 把券商成交通知 / 明細 / 口語丟給 Claude 轉成匯入，先預覽再確認',
    '/prompt <原始文字> — 不花 API 費：回你一段提示詞，拿去 Claude / ChatGPT / Gemini 跑出 JSON 再貼回來（/prompt 不帶內容 = 基礎提示詞，可存成 Project / GPT 指令）',
    '/cancel — 清掉進行中的分段 JSON',
    '匯入預覽可按「付款方式套用」一次選信用卡 / 帳戶，或「逐筆調整」改類別、付款方式、排除某筆。',
    '',
    '直接傳自由文字就會記一筆，例：',
    '  午餐 150',
    '  昨天 星巴克 180 刷玉山',
    '  USD 12.5 app 訂閱',
    '記完可用按鈕改類別、改支付方式（信用卡 / 帳戶 / LINE Pay…）或刪除。多行多筆的內容會先問你要轉匯入還是記一筆。',
  ].join('\n');
}

/** owner chat 的 /report、/invest：找 owner 所在的 household */
function tgHouseholdReportReply_(includeLedger) {
  var owner = ownerUidCached_();
  if (!owner) return '找不到 owner 帳號。';
  var docs = fsRunQuery_('', {
    from: [{ collectionId: 'households' }],
    where: { fieldFilter: { field: { fieldPath: 'memberIds' }, op: 'ARRAY_CONTAINS', value: { stringValue: owner } } },
    limit: 1,
  });
  if (!docs[0]) return '還沒有共同帳本。';
  var hid = String(docs[0]._name).split('/').pop();
  return buildHouseholdReport_(hid, {
    includeLedger: includeLedger,
    includeInvestments: true,
    title: includeLedger ? '共同帳本報告' : '共同投資現況',
  });
}

function tgBalanceReply_() {
  var now = new Date();
  var mStart = new Date(now.getFullYear(), now.getMonth(), 1);
  var mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  var txs = queryTxsBetween_(mStart, mEnd);
  var byType = aggByType_(txs);
  return [
    '[本月收支]',
    '收入：NT$' + n0(byType.income),
    '支出：NT$' + n0(byType.expense),
    '淨額：NT$' + n0(byType.income - byType.expense),
    '筆數：' + txs.length,
  ].join('\n');
}

function tgBudgetReply_() {
  var now = new Date();
  var month = Utilities.formatDate(now, TZ, 'yyyy-MM');
  var mStart = new Date(now.getFullYear(), now.getMonth(), 1);
  var mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  var txs = queryTxsBetween_(mStart, mEnd);
  var spent = aggByType_(txs).expense;
  var budget = totalMonthBudget_(month);
  if (!budget) return '本月尚未設定預算';
  var pct = (spent / budget * 100);
  return [
    '[預算進度] ' + month,
    '已花：NT$' + n0(spent) + ' / NT$' + n0(budget),
    '使用率：' + pct.toFixed(0) + '%',
    pct >= 100 ? '已超標' : pct >= 80 ? '警告：接近上限' : '正常',
  ].join('\n');
}

function tgForecastReply_() {
  var r = notifyMonthlyForecast();
  if (r && r.skipped) return '尚無資料可預測';
  return r && r.ok ? '已推送預測訊息' : '預測失敗';
}

function tgSubsReply_() {
  var subs = (function () { try { return fsListAllDocs_('subscriptions', 200); } catch (e) { return []; } })();
  var active = (subs || []).filter(function (s) { return s.active !== false; });
  if (active.length === 0) return '尚無訂閱';
  var monthly = 0;
  active.forEach(function (s) {
    var amt = s.amountTWD || 0;
    var c = s.billingCycle || 'monthly';
    if (c === 'yearly') monthly += amt / 12;
    else if (c === 'weekly') monthly += amt * 52 / 12;
    else if (c === 'biweekly') monthly += amt * 26 / 12;
    else monthly += amt;
  });
  var lines = ['[訂閱] 月平均 NT$' + n0(monthly)];
  active.slice(0, 10).forEach(function (s) {
    lines.push('· ' + (s.name || '?') + ' NT$' + n0(s.amountTWD || 0) + '/' + (s.billingCycle || 'monthly'));
  });
  return lines.join('\n');
}

function tgGoalsReply_() {
  var goals = (function () { try { return fsListDocs_('savings_goals', 100); } catch (e) { return []; } })()
    .filter(function (g) { return !g.archivedAt; });
  if (goals.length === 0) return '尚無儲蓄目標';
  var lines = ['[儲蓄目標]'];
  goals.forEach(function (g) {
    var pct = g.targetTWD ? Math.min(100, (g.currentTWD || 0) / g.targetTWD * 100) : 0;
    lines.push('· ' + (g.name || '?') + ' ' + Math.round(pct) + '% (' + n0(g.currentTWD || 0) + '/' + n0(g.targetTWD || 0) + ')');
  });
  return lines.join('\n');
}

function tgScheduledReply_() {
  var items = (function () { try { return fsListAllDocs_('scheduled_payments', 200); } catch (e) { return []; } })();
  var today = startOfDayTW_(new Date());
  var hits = (items || []).map(function (p) {
    if (p.recurrence === 'one-time' && p.paidAt) return null;
    var due = p.dueDate instanceof Date ? p.dueDate : new Date(p.dueDate);
    var days = Math.round((due.getTime() - today.getTime()) / 86400000);
    return { p: p, days: days };
  }).filter(function (x) { return x && x.days <= 60; });
  hits.sort(function (a, b) { return a.days - b.days; });
  if (hits.length === 0) return '60 天內無排程';
  var lines = ['[即將排程]'];
  hits.forEach(function (h) {
    var label = h.days < 0 ? '已逾期 ' + Math.abs(h.days) + ' 天'
      : h.days === 0 ? '今日'
        : h.days + ' 天後';
    lines.push('· ' + (h.p.name || '?') + ' NT$' + n0(h.p.amountTWD || 0) + ' — ' + label);
  });
  return lines.join('\n');
}

function tgAskReply_(question) {
  if (!question) return '用法：/ask 上個月餐飲花多少';
  var res = askFinance({ question: question });
  if (!res.ok) return '查詢失敗：' + (res.error || 'unknown');
  return res.answer;
}

function tgMarkPaidReply_(pmKey) {
  if (!pmKey) return '請給卡片 id：/paid <pmKey>';
  // 找出該卡本期 cycleMonth
  var pm = fsGetDoc_('payment_methods/' + pmKey);
  if (!pm) return '找不到卡片：' + pmKey;
  if (pm.type !== 'credit') return pmKey + ' 不是信用卡';
  if (!pm.dueDay) return pmKey + ' 未設繳款日';
  var today = startOfDayTW_(new Date());
  var due = currentDueDate_(parseInt(pm.dueDay, 10), today);
  var cycleMonth = cycleMonthKey_(due);
  var billId = pmKey + '__' + cycleMonth;
  var bill = fsGetDoc_('credit_card_bills/' + billId);
  var now = new Date();
  if (bill) {
    fsSetDoc_('credit_card_bills/' + billId, { paidAt: now, updatedAt: now }, true);
  } else {
    fsSetDoc_('credit_card_bills/' + billId, {
      paymentMethodId: pmKey, cycleMonth: cycleMonth, dueDate: due,
      paidAt: now, statementDate: null, dueDateOverride: null, overrideReason: null,
      amount: null, note: null, createdAt: now, updatedAt: now,
    }, false);
  }
  return '已標記 ' + (pm.name || pmKey) + ' ' + cycleMonth + ' 為已繳費';
}

function tgQuickEntry_(text) {
  var owner = getOwnerUid_();
  if (!owner) return '無法判斷使用者，請在 web 端重新登入一次';

  var ctx = tgLoadEntryContext_();
  var parsed = null;
  var via = 'claude';
  try {
    parsed = tgParseEntryWithClaude_(text, ctx);
  } catch (err) {
    console.warn('tgParseEntryWithClaude_', err);
  }
  if (!parsed) {
    via = 'regex';
    parsed = tgParseEntryRegex_(text);
    if (typeof parsed === 'string') return parsed; // 錯誤訊息
  }

  var entry = tgNormalizeEntry_(parsed, ctx);
  if (!entry.amount || entry.amount <= 0) return '找不到有效金額';

  var now = new Date();
  var doc = {
    userId: owner,
    type: entry.type,
    amount: entry.amount,
    currency: entry.currency,
    amountTWD: entry.amountTWD,
    fxRate: entry.fxRate,
    category: entry.category,
    paymentMethod: entry.paymentMethod,
    fromAccountId: entry.type === 'expense' ? entry.accountId : null,
    toAccountId: entry.type === 'income' ? entry.accountId : null,
    note: entry.note,
    date: entry.date,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    tripId: null,
    splitMode: null,
    counterpartyName: null,
    myShareTWD: null,
    settledAmountTWD: null,
    settledFxRate: null,
    settledAt: null,
    source: 'telegram',
  };
  var created = fsAddDoc_('transactions', doc);
  var txId = created && created.name ? String(created.name).split('/').pop() : null;
  // 有對到帳戶就同步餘額（與 web createTransaction / 匯入 importApplyLedger_ 一致）
  try { tgAdjustTxAccount_(doc, 1); } catch (adjErr) { console.warn('tgQuickEntry_ adjust account', adjErr); }

  var summary = tgEntrySummary_(entry, ctx);
  if (!txId) {
    sendTelegram(summary + '\n（無法取得交易 id，請到 web 端確認）');
    return TG_REPLY_SENT_;
  }
  var sent = sendTelegramWithMarkup_(summary + (via === 'regex' ? '\n（Claude 未啟用，使用簡易解析）' : ''), tgEntryKeyboard_(txId));
  if (!sent.ok) sendTelegram(summary);
  return TG_REPLY_SENT_;
}

/** 讀類別 / 支付方式 / 帳戶，給解析與驗證用（webhook 內只做一次） */
function tgLoadEntryContext_() {
  var ctx = { categories: [], paymentMethods: [], accounts: [] };
  try {
    ctx.categories = fsListDocs_('categories', 100)
      .filter(function (c) { return !c.archivedAt; })
      .map(function (c) {
        return { key: c.key || String(c._name).split('/').pop(), name: c.name || '', type: c.type || 'expense' };
      });
  } catch (err) { console.warn('tgLoadEntryContext_ categories', err); }
  try {
    ctx.paymentMethods = fsListDocs_('payment_methods', 50)
      .filter(function (p) { return !p.archivedAt; })
      .map(function (p) { return { key: p.key || String(p._name).split('/').pop(), name: p.name || '', type: p.type || 'other' }; });
  } catch (err) { console.warn('tgLoadEntryContext_ payment_methods', err); }
  try {
    ctx.accounts = fsListAllDocs_('accounts', 100)
      .filter(function (a) { return a.active !== false && !a.archivedAt; })
      .map(function (a) {
        return {
          id: String(a._name).split('/').pop(),
          name: a.name || '',
          type: a.type || 'cash',
          legacyPaymentMethod: a.legacyPaymentMethod || null,
        };
      });
  } catch (err) { console.warn('tgLoadEntryContext_ accounts', err); }
  return ctx;
}

var TG_ENTRY_CURRENCIES_ = ['TWD', 'USD', 'JPY', 'EUR', 'IDR'];

function tgParseEntryWithClaude_(text, ctx) {
  if (!claudeConfigured_()) return null;
  var todayTW = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  var weekdayTW = Utilities.formatDate(new Date(), 'Asia/Taipei', 'EEEE');
  var catLines = ctx.categories.map(function (c) { return c.key + ' = ' + c.name + ' (' + c.type + ')'; }).join('\n');
  var pmNames = [];
  ctx.paymentMethods.forEach(function (p) { if (p.name) pmNames.push(p.name); });
  ctx.accounts.forEach(function (a) {
    var n = a.legacyPaymentMethod || a.name;
    if (n && pmNames.indexOf(n) === -1) pmNames.push(n);
  });
  ['現金', '信用卡', '轉帳', 'Line Pay'].forEach(function (n) { if (pmNames.indexOf(n) === -1) pmNames.push(n); });

  var prompt = [
    '你是記帳助理。把使用者的一句話解析成 JSON 交易。',
    '今天是 ' + todayTW + '（' + weekdayTW + '，Asia/Taipei）。',
    '',
    '可用類別（只能回傳 key）：',
    catLines || 'other = 其他 (expense)',
    '',
    '可用支付方式（回傳完全相同的名稱；使用者沒提就回 null）：',
    pmNames.join('、'),
    '',
    '規則：',
    '- type：收到錢 / 薪水 / 退款 / 入帳 → income，否則 expense。',
    '- amount：數字（原幣金額）。找不到金額 → amount 為 0。',
    '- currency：TWD / USD / JPY / EUR / IDR；「美金 / 美元 / $ + 明顯美金語境」→ USD，「日幣 / 円」→ JPY，預設 TWD。',
    '- date：YYYY-MM-DD；「昨天 / 前天 / 上週五 / 3號」要換算成實際日期，沒提就用今天。',
    '- note：簡短描述（店名 / 品項），去掉金額、日期、支付方式等已結構化的字；沒有就用類別名稱。',
    '- paymentMethod：使用者提到「刷 X / 用 X 付 / X 卡」時對應到上面清單中最接近的名稱，否則 null。',
    '- category：從清單挑最合適的 key，type 要對應（expense 用 expense 類別、income 用 income 類別）。',
    '',
    '只回傳 JSON 物件：{"type":"expense","amount":150,"currency":"TWD","category":"food","paymentMethod":null,"date":"' + todayTW + '","note":"午餐"}',
    '',
    '使用者輸入：' + text,
  ].join('\n');

  try {
    var parsed = callClaudeJson_({
      feature: 'telegramQuickEntry', tier: 'fast', effort: 'low', maxTokens: 2000, prompt: prompt,
    }).json;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (err) {
    console.warn('claude quick entry failed', err && err.message, err && err.raw);
    return null;
  }
}

/** 舊版簡易解析（fallback）：描述 金額 [類別 hint]。回傳物件或錯誤字串。 */
function tgParseEntryRegex_(text) {
  var tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return '格式：描述 金額（例：午餐 150）';
  var amount = null;
  var amountIdx = -1;
  for (var i = 0; i < tokens.length; i++) {
    var n = parseFloat(tokens[i]);
    if (!isNaN(n) && tokens[i].match(/^\d+(\.\d+)?$/)) {
      amount = n;
      amountIdx = i;
      break;
    }
  }
  if (amount === null || amount <= 0) return '找不到有效金額';
  var note = tokens.slice(0, amountIdx).join(' ') || '快速記帳';
  var hint = tokens.slice(amountIdx + 1).join(' ').toLowerCase();
  var category = 'other';
  if (hint) category = hint;
  else {
    var noteLower = note.toLowerCase();
    if (/午餐|早餐|晚餐|早午餐|餐|吃飯|飲料|咖啡|茶|麥當勞|星巴克|肯德基/.test(noteLower)) category = 'food';
    else if (/捷運|公車|計程車|高鐵|火車|交通|油錢|停車|uber/.test(noteLower)) category = 'transport';
    else if (/購物|衣服|鞋子|家具|生活用品|超市|超商|7-11|全家/.test(noteLower)) category = 'shopping';
    else if (/水費|電費|瓦斯|手機費|網路|帳單/.test(noteLower)) category = 'utilities';
  }
  return { type: 'expense', amount: amount, currency: 'TWD', category: category, paymentMethod: null, date: null, note: note };
}

/** 驗證 / 補齊解析結果：類別存在、支付方式對應帳戶、匯率、日期 */
function tgNormalizeEntry_(p, ctx) {
  var type = p.type === 'income' ? 'income' : 'expense';
  var amount = Math.abs(parseFloat(p.amount)) || 0;
  var currency = String(p.currency || 'TWD').toUpperCase();
  if (TG_ENTRY_CURRENCIES_.indexOf(currency) === -1) currency = 'TWD';

  // 類別：key 必須存在且 type 相符；否則 fallback
  var catKey = String(p.category || '').trim();
  var cat = null;
  for (var i = 0; i < ctx.categories.length; i++) {
    if (ctx.categories[i].key === catKey && ctx.categories[i].type === type) { cat = ctx.categories[i]; break; }
  }
  if (!cat) {
    // 允許用名稱比對（regex fallback 的 hint 可能是中文名）
    for (var j = 0; j < ctx.categories.length; j++) {
      if (ctx.categories[j].type === type && ctx.categories[j].name === catKey) { cat = ctx.categories[j]; break; }
    }
  }
  var category = cat ? cat.key : (type === 'income' ? 'other_income' : 'other');

  // 支付方式 + 帳戶
  var pmName = p.paymentMethod ? String(p.paymentMethod).trim() : '';
  var account = null;
  if (pmName) {
    for (var k = 0; k < ctx.accounts.length; k++) {
      var a = ctx.accounts[k];
      if (a.legacyPaymentMethod === pmName || a.name === pmName) { account = a; break; }
    }
  }
  if (!pmName) pmName = '現金';
  var accountId = account ? account.id : null;
  if (!account && pmName === '現金') {
    var cashAccounts = ctx.accounts.filter(function (a) { return a.type === 'cash'; });
    if (cashAccounts.length === 1) accountId = cashAccounts[0].id;
  }

  // 匯率
  var fxRate = 1;
  if (currency !== 'TWD') {
    try {
      var fx = fsGetDoc_('fx_rates/' + currency + '_TWD');
      if (fx && fx.rate) fxRate = Number(fx.rate) || 1;
    } catch (err) { console.warn('tgNormalizeEntry_ fx', err); }
  }
  var amountTWD = Math.round(amount * fxRate * 100) / 100;

  // 日期：YYYY-MM-DD 視為台北當地，取當天中午避免跨日
  var date = new Date();
  if (p.date && /^\d{4}-\d{2}-\d{2}$/.test(String(p.date))) {
    var parts = String(p.date).split('-');
    date = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 4, 0, 0)); // 12:00 TW
    var todayTW = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
    if (String(p.date) === todayTW) date = new Date();
  }

  var note = String(p.note || '').trim();
  if (!note) note = cat ? cat.name : '快速記帳';

  return {
    type: type,
    amount: amount,
    currency: currency,
    amountTWD: amountTWD,
    fxRate: fxRate,
    category: category,
    categoryName: cat ? cat.name : category,
    paymentMethod: pmName,
    accountId: accountId,
    accountName: account ? account.name : null,
    note: note,
    date: date,
  };
}

function tgEntrySummary_(entry, ctx) {
  void ctx;
  var lines = [];
  var sign = entry.type === 'income' ? '+' : '-';
  var amountText = entry.currency === 'TWD'
    ? 'NT$' + n0(entry.amount)
    : entry.currency + ' ' + entry.amount + '（約 NT$' + n0(entry.amountTWD) + '）';
  lines.push((entry.type === 'income' ? '已記收入 ' : '已記支出 ') + sign + amountText);
  lines.push('類別：' + entry.categoryName + ' · ' + entry.paymentMethod + (entry.accountName && entry.accountName !== entry.paymentMethod ? '（' + entry.accountName + '）' : ''));
  lines.push('備註：' + entry.note);
  lines.push('日期：' + Utilities.formatDate(entry.date, 'Asia/Taipei', 'yyyy-MM-dd'));
  return lines.join('\n');
}

function tgEntryKeyboard_(txId) {
  return {
    inline_keyboard: [[
      { text: '改類別', callback_data: 'qe:cat:' + txId },
      { text: '改支付方式', callback_data: 'qe:pm:' + txId },
      { text: '刪除', callback_data: 'qe:del:' + txId },
    ]],
  };
}

/**
 * 快速記帳的「改支付方式」鍵盤：帳戶 + 自訂支付方式 + 預設，清單動態來自 Firestore（importPaymentOptions_）。
 * callback 帶 index + 名稱短 hash，清單變動時會要求重選。
 */
function tgPaymentKeyboard_(txId, type, ctx) {
  var options = importPaymentOptions_(ctx, type === 'income' ? 'income' : 'expense');
  var rows = [];
  var line = [];
  options.forEach(function (o, idx) {
    var data = 'qe:pms:' + txId + ':' + idx + ':' + importShortHash_(o.paymentMethod + '|' + (o.accountId || ''));
    if (tgCallbackBytes_(data) > TG_CALLBACK_MAX_BYTES_) return;
    line.push({ text: o.label.slice(0, 40), callback_data: data });
    if (line.length === 2) { rows.push(line); line = []; }
  });
  if (line.length) rows.push(line);
  rows.push([{ text: '返回', callback_data: 'qe:back:' + txId }]);
  return { inline_keyboard: rows };
}

/**
 * 依交易 doc 調整對應帳戶餘額。sign = 1 套用、-1 還原（刪除 / 改支付方式時先還原再套用）。
 * 支出扣 fromAccountId、收入進 toAccountId；沒有帳戶就什麼都不做。
 */
function tgAdjustTxAccount_(tx, sign) {
  if (!tx || tx.type === 'transfer') return;
  var accountId = tx.type === 'income' ? tx.toAccountId : tx.fromAccountId;
  if (!accountId) return;
  var dir = tx.type === 'income' ? 1 : -1;
  var amount = Number(tx.amount) || 0;
  var amountTWD = Number(tx.amountTWD) || amount;
  importAdjustAccount_(accountId, tx.currency || 'TWD', sign * dir * amount, sign * dir * amountTWD);
}

function tgCategoryKeyboard_(txId, type, ctx) {
  var rows = [];
  var row = [];
  ctx.categories.filter(function (c) { return c.type === type; }).forEach(function (c) {
    // callback_data 上限 64 bytes：'qe:set:' + 20 字 id + ':' + key
    var data = 'qe:set:' + txId + ':' + c.key;
    if (data.length > 64) return;
    row.push({ text: c.name, callback_data: data });
    if (row.length === 3) { rows.push(row); row = []; }
  });
  if (row.length) rows.push(row);
  rows.push([{ text: '返回', callback_data: 'qe:back:' + txId }]);
  return { inline_keyboard: rows };
}

/**
 * owner chat 的發送者檢查（2026-11 稽核 S6）。
 * - 私訊：chat.id 就是 from.id，TG_CHAT_ID 比對已足夠 → 放行。
 * - 群組 / 頻道：TG_CHAT_ID 對上只代表「在這個群」，群裡其他人也能記帳、查 owner 的帳。
 *   設 Script Property TG_ALLOWED_USER_IDS（逗號分隔的 Telegram user id）後只放行名單內的人；
 *   沒設就維持舊行為並留 warning，避免一上線就把 owner 自己擋掉。
 */
function tgSenderAllowed_(msg) {
  var chat = (msg && msg.chat) || {};
  if (!chat.type || chat.type === 'private') return true;
  var raw = PROP.getProperty('TG_ALLOWED_USER_IDS');
  if (!raw) {
    console.warn('tgSenderAllowed_: group chat without TG_ALLOWED_USER_IDS — anyone in the group can use owner commands');
    return true;
  }
  var fromId = msg && msg.from && msg.from.id;
  if (fromId == null) return false;
  var allowed = String(raw).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  return allowed.indexOf(String(fromId)) >= 0;
}

/** inline keyboard callback：qe:cat / qe:set / qe:pm / qe:pms / qe:del / qe:back；imp:* 交給 ImportTelegram.gs */
function tgHandleCallback_(cq, updateId) {
  var chatId = String((cq.message && cq.message.chat && cq.message.chat.id) || '');
  var allowedChat = PROP.getProperty('TG_CHAT_ID');
  if (!allowedChat || chatId !== String(allowedChat)) {
    tgAnswerCallback_(cq.id, '未授權');
    return jsonResponse_({ ok: true, skipped: 'chat-not-allowed' });
  }
  if (!tgSenderAllowed_({ chat: cq.message && cq.message.chat, from: cq.from })) {
    tgAnswerCallback_(cq.id, '未授權');
    return jsonResponse_({ ok: true, skipped: 'sender-not-allowed' });
  }
  var messageId = cq.message && cq.message.message_id;
  var data = String(cq.data || '');
  var parts = data.split(':');
  if (parts[0] === 'imp' && parts.length >= 3) {
    try {
      return tgHandleImportCallback_(cq, parts, updateId);
    } catch (impErr) {
      console.error('tgHandleImportCallback_', impErr);
      try { logErrorToFirestore_('tgImportCallback', impErr, { data: data }); } catch (ignoredErr) { console.warn('[TelegramBot:859] ignored', ignoredErr); }
      try { tgAnswerCallback_(cq.id, '匯入失敗'); } catch (ignoredErr) { console.warn('[TelegramBot:860] ignored', ignoredErr); }
      return jsonResponse_({ ok: true, error: String(impErr && impErr.message || impErr) });
    }
  }
  if (parts[0] !== 'qe' || parts.length < 3) {
    tgAnswerCallback_(cq.id, '');
    return jsonResponse_({ ok: true, skipped: 'unknown-callback' });
  }
  var op = parts[1];
  var txId = parts[2];
  var originalText = String((cq.message && cq.message.text) || '');
  // 去掉之前附加的狀態列（以「→」開頭）
  var baseText = originalText.split('\n').filter(function (l) { return l.indexOf('→') !== 0; }).join('\n');

  try {
    var tx = fsGetDoc_('transactions/' + txId);
    if (!tx) {
      tgAnswerCallback_(cq.id, '找不到這筆交易');
      tgEditMessage_(chatId, messageId, baseText + '\n→ 交易已不存在', null);
      return jsonResponse_({ ok: true, updateId: updateId, callback: 'missing' });
    }
    if (op === 'cat') {
      var ctx = tgLoadEntryContext_();
      tgAnswerCallback_(cq.id, '');
      tgEditMessage_(chatId, messageId, baseText + '\n→ 選一個類別', tgCategoryKeyboard_(txId, tx.type === 'income' ? 'income' : 'expense', ctx));
      return jsonResponse_({ ok: true, updateId: updateId, callback: 'cat-menu' });
    }
    if (op === 'back') {
      tgAnswerCallback_(cq.id, '');
      tgEditMessage_(chatId, messageId, baseText, tgEntryKeyboard_(txId));
      return jsonResponse_({ ok: true, updateId: updateId, callback: 'back' });
    }
    if (op === 'pm') {
      var ctxPm = tgLoadEntryContext_();
      tgAnswerCallback_(cq.id, '');
      tgEditMessage_(chatId, messageId, baseText + '\n→ 選一個支付方式 / 帳戶（有帳戶的會同步餘額）', tgPaymentKeyboard_(txId, tx.type, ctxPm));
      return jsonResponse_({ ok: true, updateId: updateId, callback: 'pm-menu' });
    }
    if (op === 'pms') {
      var ctxPms = tgLoadEntryContext_();
      var options = importPaymentOptions_(ctxPms, tx.type === 'income' ? 'income' : 'expense');
      var opt = options[parseInt(parts[3], 10)];
      if (!opt || importShortHash_(opt.paymentMethod + '|' + (opt.accountId || '')) !== parts[4]) {
        tgAnswerCallback_(cq.id, '清單已變動，請重選');
        tgEditMessage_(chatId, messageId, baseText, tgEntryKeyboard_(txId));
        return jsonResponse_({ ok: true, updateId: updateId, callback: 'pm-stale' });
      }
      if (tx.deletedAt) {
        tgAnswerCallback_(cq.id, '這筆已刪除');
        return jsonResponse_({ ok: true, updateId: updateId, callback: 'pm-deleted' });
      }
      // 先還原舊帳戶，再套用新帳戶
      try { tgAdjustTxAccount_(tx, -1); } catch (revErr) { console.warn('qe:pms revert', revErr); }
      var patch = { paymentMethod: opt.paymentMethod, updatedAt: new Date() };
      if (tx.type === 'income') { patch.toAccountId = opt.accountId || null; patch.fromAccountId = null; }
      else { patch.fromAccountId = opt.accountId || null; patch.toAccountId = null; }
      fsSetDoc_('transactions/' + txId, patch, true);
      var nextTx = {}; Object.keys(tx).forEach(function (k) { nextTx[k] = tx[k]; }); Object.keys(patch).forEach(function (k) { nextTx[k] = patch[k]; });
      try { tgAdjustTxAccount_(nextTx, 1); } catch (appErr) { console.warn('qe:pms apply', appErr); }
      var pmLabel = opt.paymentMethod + (opt.accountName && opt.accountName !== opt.paymentMethod ? '（' + opt.accountName + '）' : '');
      tgAnswerCallback_(cq.id, '已改為 ' + pmLabel);
      var updatedPm = baseText.replace(/^(類別：[^·\n]*·\s*)[^\n]*/m, '$1' + pmLabel);
      tgEditMessage_(chatId, messageId, updatedPm + '\n→ 支付方式已改為 ' + pmLabel, tgEntryKeyboard_(txId));
      return jsonResponse_({ ok: true, updateId: updateId, callback: 'pm-set' });
    }
    if (op === 'set') {
      var catKey = parts.slice(3).join(':');
      var ctx2 = tgLoadEntryContext_();
      var cat = null;
      for (var i = 0; i < ctx2.categories.length; i++) if (ctx2.categories[i].key === catKey) { cat = ctx2.categories[i]; break; }
      if (!cat) {
        tgAnswerCallback_(cq.id, '類別不存在');
        return jsonResponse_({ ok: true, updateId: updateId, callback: 'bad-cat' });
      }
      fsSetDoc_('transactions/' + txId, { category: cat.key, updatedAt: new Date() }, true);
      tgAnswerCallback_(cq.id, '已改為 ' + cat.name);
      var updated = baseText.replace(/^類別：[^·\n]*/m, '類別：' + cat.name + ' ');
      tgEditMessage_(chatId, messageId, updated + '\n→ 類別已改為 ' + cat.name, tgEntryKeyboard_(txId));
      return jsonResponse_({ ok: true, updateId: updateId, callback: 'set' });
    }
    if (op === 'del') {
      if (tx.deletedAt) {
        tgAnswerCallback_(cq.id, '已經刪除過了');
        return jsonResponse_({ ok: true, updateId: updateId, callback: 'already-deleted' });
      }
      fsSetDoc_('transactions/' + txId, { deletedAt: new Date(), updatedAt: new Date() }, true);
      // 還原帳戶餘額（web 的 softDeleteTransaction 也會做同一件事）
      try { tgAdjustTxAccount_(tx, -1); } catch (delErr) { console.warn('qe:del revert', delErr); }
      tgAnswerCallback_(cq.id, '已刪除');
      tgEditMessage_(chatId, messageId, baseText + '\n→ 已刪除（web 回收筒 7 天內可還原）', null);
      return jsonResponse_({ ok: true, updateId: updateId, callback: 'del' });
    }
    tgAnswerCallback_(cq.id, '');
    return jsonResponse_({ ok: true, skipped: 'unknown-op' });
  } catch (err) {
    console.error('tgHandleCallback_', err);
    try { logErrorToFirestore_('tgCallback', err, { data: data }); } catch (ignoredErr) { console.warn('[TelegramBot:956] ignored', ignoredErr); }
    try { tgAnswerCallback_(cq.id, '處理失敗'); } catch (ignoredErr) { console.warn('[TelegramBot:957] ignored', ignoredErr); }
    return jsonResponse_({ ok: true, error: String(err && err.message || err) });
  }
}

function getOwnerUid_() {
  try {
    var users = fsRunQuery_('', {
      from: [{ collectionId: 'users' }],
      where: { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL',
        value: { stringValue: 'owner' } } },
      limit: 1,
    });
    var u = users[0];
    if (!u || !u._name) {
      // 首位使用者建 doc 時 role 是 'admin' 而不是 'owner'
      var admins = fsRunQuery_('', {
        from: [{ collectionId: 'users' }],
        where: { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL',
          value: { stringValue: 'admin' } } },
        limit: 1,
      });
      u = admins[0];
    }
    return u && u._name ? u._name.split('/').pop() : null;
  } catch (err) {
    console.warn('getOwnerUid_', err);
    return null;
  }
}

/**
 * 一次性註冊 webhook（手動執行）。需先在 Script Properties 設好 TG_BOT_TOKEN / TG_WEBHOOK_SECRET。
 * 並把當前部署的 web app URL 傳進去（從 deploy 拿）。
 */
function setupTelegramWebhook(webAppUrl) {
  var token = PROP.getProperty('TG_BOT_TOKEN');
  var secret = PROP.getProperty('TG_WEBHOOK_SECRET');
  if (!token) return { ok: false, error: 'TG_BOT_TOKEN-not-set' };
  if (!secret) return { ok: false, error: 'TG_WEBHOOK_SECRET-not-set' };
  if (!webAppUrl) return { ok: false, error: 'web-app-url-required' };
  var hookUrl = webAppUrl + (webAppUrl.indexOf('?') === -1 ? '?' : '&')
    + 'action=tgWebhook&secret=' + encodeURIComponent(secret);
  var resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/setWebhook?url=' + encodeURIComponent(hookUrl), { muteHttpExceptions: true });
  return JSON.parse(resp.getContentText());
}

function deleteTelegramWebhook() {
  var token = PROP.getProperty('TG_BOT_TOKEN');
  if (!token) return { ok: false, error: 'TG_BOT_TOKEN-not-set' };
  var resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/deleteWebhook', { muteHttpExceptions: true });
  return JSON.parse(resp.getContentText());
}

/**
 * 緊急用：bot 卡在 loop 時跑這個。
 * - drop_pending_updates=true 會丟掉 Telegram 端排隊的所有舊 update（loop 元兇）
 * - 同時保留現有 webhook URL 不變
 */
function tgFlushPendingUpdates() {
  var token = PROP.getProperty('TG_BOT_TOKEN');
  if (!token) return { ok: false, error: 'TG_BOT_TOKEN-not-set' };
  // 先看現在註冊的 webhook URL
  var info = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getWebhookInfo', { muteHttpExceptions: true });
  var infoJson = JSON.parse(info.getContentText());
  var currentUrl = (infoJson && infoJson.result && infoJson.result.url) || null;
  if (!currentUrl) {
    return { ok: false, error: 'no-webhook-registered', getWebhookInfo: infoJson };
  }
  // 重新註冊同一個 URL，附加 drop_pending_updates=true → Telegram 清掉排隊 updates
  var url = 'https://api.telegram.org/bot' + token + '/setWebhook'
    + '?url=' + encodeURIComponent(currentUrl)
    + '&drop_pending_updates=true';
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  return {
    ok: true,
    setWebhookResult: JSON.parse(resp.getContentText()),
    pendingBefore: (infoJson.result && infoJson.result.pending_update_count) || 0,
  };
}

/** 看目前 webhook 狀態（pending / 最後錯誤等），排查 loop 用 */
function tgWebhookInfo() {
  var token = PROP.getProperty('TG_BOT_TOKEN');
  if (!token) return { ok: false, error: 'TG_BOT_TOKEN-not-set' };
  var resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getWebhookInfo', { muteHttpExceptions: true });
  return JSON.parse(resp.getContentText());
}
