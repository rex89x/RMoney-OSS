/**
 * Telegram 的 AI 匯入（互動式）：
 *   /import <JSON>        — 直接貼 RMoney 匯入 JSON（或把 JSON 存成 .json / .txt 檔傳給 bot）
 *   直接貼 { / [ / ```json 開頭的訊息 — 同 /import（彎引號、單引號、尾逗號會自動修）
 *   JSON 被 4096 字切成多則 — bot 會說「還沒結束」，接著貼下一段會自動接起來（或按「就用目前這些」）
 *   /ai <原始文字>        — 先用 Claude 轉成 JSON（券商成交通知 / 明細 / 口語），再走同一條預覽流程
 *   /prompt <原始文字>    — 不花 API 費的路：bot 把「系統規則 + 你的內容」組成一段提示詞回給你（可長按複製、
 *                           或一鍵在 ChatGPT / Claude 開啟），你拿去任何模型跑出 JSON，再貼回來匯入
 *   /prompt（不帶內容）   — 只回基礎提示詞，存成 Claude Project / Custom GPT / Gemini Gem 的指令，之後只丟原始內容
 *   多行 / 多筆的自由文字 — bot 先問要「Claude 轉匯入」「產生提示詞」還是「當一筆記帳」
 *
 * 預覽訊息的按鈕：
 *   確認匯入 / 取消
 *   付款方式套用 — 一次把某個帳戶 / 支付方式套到所有沒指定的記帳列（信用卡、現金、LINE Pay…清單動態來自帳戶與支付方式）
 *   逐筆調整     — 一筆一筆看：改類別、改付款方式、排除 / 納入，上一筆 / 下一筆
 * 待確認資料放 ScriptCache 1 小時；只有 owner chat（TG_CHAT_ID）能用，成員 chat 的訊息不會進到這裡。
 */
var TG_IMPORT_CACHE_PREFIX_ = 'tgimp:';
var TG_IMPORT_PART_KEY_ = 'tgimppart';
var TG_IMPORT_TTL_SEC_ = 3600;
var TG_IMPORT_PART_TTL_SEC_ = 900;
var TG_IMPORT_PREVIEW_ROWS_ = 15;
var TG_CALLBACK_MAX_BYTES_ = 64;

/** 文字看起來像 JSON（貼 ChatGPT 的輸出不用再加 /import；容許前面的彎引號 / 全形括號） */
function tgLooksLikeImportJson_(text) {
  return importLooksLikeJsonStart_(text);
}

/** callback_data 是 bytes 上限 64；中文 3 bytes / 字 */
function tgCallbackBytes_(s) {
  return unescape(encodeURIComponent(String(s))).length;
}

function tgImportNewToken_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function tgImportCache_() {
  return CacheService.getScriptCache();
}

function tgImportLoadPending_(token) {
  var raw = tgImportCache_().get(TG_IMPORT_CACHE_PREFIX_ + token);
  return raw ? JSON.parse(raw) : null;
}

function tgImportSavePending_(token, pending) {
  tgImportCache_().put(TG_IMPORT_CACHE_PREFIX_ + token, JSON.stringify(pending), TG_IMPORT_TTL_SEC_);
}

// ───────────────────────── 進入點：貼 JSON / 檔案 / 接續 ─────────────────────────

/**
 * 解析 → 正規化 → 預覽。截斷的內容會先存起來等下一段（opts.allowPartial = false 時直接用現有的）。
 * 回 TG_REPLY_SENT_（自己送了訊息）或錯誤字串。
 */
function tgImportFromText_(text, via, opts) {
  var owner = getOwnerUid_();
  if (!owner) return '無法判斷使用者，請在 web 端重新登入一次';
  var parsed = importParseEnvelope_(text);
  var cache = tgImportCache_();

  if (parsed.truncated && (!opts || opts.allowPartial !== false)) {
    // 被 Telegram 切斷：留著等下一段。有解析出來的筆數就給「就用目前這些」
    cache.put(TG_IMPORT_PART_KEY_, String(text), TG_IMPORT_PART_TTL_SEC_);
    var okSoFar = parsed.items.length;
    var msg = 'JSON 還沒結束（括號沒收完，通常是 Telegram 把長訊息切開了）。目前收到 ' + String(text).length + ' 字'
      + (okSoFar ? '、可辨識 ' + okSoFar + ' 筆' : '') + '。\n請直接接著貼下一段，我會自動接起來；太長也可以改傳 .json 檔。';
    var kb = { inline_keyboard: [[
      okSoFar ? { text: '就用目前這 ' + okSoFar + ' 筆', callback_data: 'imp:part:ok' } : null,
      { text: '取消', callback_data: 'imp:part:no' },
    ].filter(Boolean)] };
    var sentPart = sendTelegramWithMarkup_(msg, kb);
    if (!sentPart.ok) sendTelegram(msg);
    return TG_REPLY_SENT_;
  }
  cache.remove(TG_IMPORT_PART_KEY_);

  if (parsed.error) {
    var hint = parsed.rejected.length ? '\n' + parsed.rejected.slice(0, 5).map(function (r) { return '#' + (r.index + 1) + '：' + r.message; }).join('\n') : '';
    return '匯入 JSON 有問題：' + parsed.error + hint
      + '\n（引號 / 逗號 / 括號的小錯會自動修；若還是不行，請用 /prompt 重新產生提示詞再跑一次，或改用 /ai <原始文字> 讓 Claude 轉換。）';
  }
  var ctx = importLoadContext_(owner);
  var rows = importNormalize_(parsed.items, ctx);
  var token = tgImportNewToken_();
  var pending = {
    rows: rows, owner: owner, via: via || null,
    rejected: parsed.rejected.length, repaired: !!parsed.repaired, truncated: !!parsed.truncated,
  };
  tgImportSavePending_(token, pending);
  var text2 = tgImportPreviewText_(pending);
  var sent = sendTelegramWithMarkup_(text2, tgImportKeyboard_(token, rows));
  if (!sent.ok) sendTelegram(text2);
  return TG_REPLY_SENT_;
}

/** 有未完成的分段時，下一則非指令訊息會接到這裡；沒有分段回 null */
function tgImportContinuePartial_(text) {
  var cache = tgImportCache_();
  var partial = cache.get(TG_IMPORT_PART_KEY_);
  if (!partial) return null;
  // 直接接起來（不加換行）：Telegram 可能把一個 token 從中間切開
  return tgImportFromText_(partial + String(text || ''), '分段貼上');
}

function tgImportHasPartial_() {
  return !!tgImportCache_().get(TG_IMPORT_PART_KEY_);
}

function tgImportCancelPartial_() {
  var cache = tgImportCache_();
  var had = !!cache.get(TG_IMPORT_PART_KEY_);
  cache.remove(TG_IMPORT_PART_KEY_);
  return had ? '已清除未完成的分段內容。' : '目前沒有進行中的匯入。';
}

// ───────────────────────── 預覽文字與鍵盤 ─────────────────────────

function tgImportCounts_(rows) {
  var c = { ledger: 0, trades: 0, errors: 0, warns: 0, excluded: 0, ok: 0, unmatched: 0 };
  rows.forEach(function (r) {
    if (r.kind === 'trade') c.trades += 1; else c.ledger += 1;
    if (r.excluded) { c.excluded += 1; return; }
    if (r.status === 'error') c.errors += 1;
    else { c.ok += 1; if (r.status === 'warn') c.warns += 1; }
    if (r.kind !== 'trade' && !r.resolved.paymentMatched) c.unmatched += 1;
  });
  return c;
}

function tgImportPreviewText_(pending) {
  var rows = pending.rows;
  var c = tgImportCounts_(rows);
  var lines = [];
  lines.push('匯入預覽' + (pending.via ? '（' + pending.via + '）' : '') + '：' + rows.length + ' 筆'
    + (c.ledger ? '，記帳 ' + c.ledger : '') + (c.trades ? '，股票成交 ' + c.trades : '')
    + (c.warns ? '，△ 需留意 ' + c.warns : '') + (c.errors ? '，✗ 不匯入 ' + c.errors : '') + (c.excluded ? '，○ 已排除 ' + c.excluded : ''));
  if (pending.repaired) lines.push('（貼進來的 JSON 有引號 / 逗號 / 括號問題，已自動修正）');
  if (pending.truncated) lines.push('（內容被截斷，最後一筆不完整已略過）');
  if (pending.rejected) lines.push('另有 ' + pending.rejected + ' 筆格式不對已略過。');
  lines.push('');
  rows.slice(0, TG_IMPORT_PREVIEW_ROWS_).forEach(function (row) { lines.push(importRowSummary_(row)); });
  if (rows.length > TG_IMPORT_PREVIEW_ROWS_) lines.push('… 還有 ' + (rows.length - TG_IMPORT_PREVIEW_ROWS_) + ' 筆未列出（按「逐筆調整」可看）');
  lines.push('');
  var total = 0;
  rows.forEach(function (r) { if (r.status !== 'error' && !r.excluded && r.kind === 'expense') total += r.resolved.amountTWD; });
  if (total > 0) lines.push('支出合計約 NT$' + Math.round(total).toLocaleString());
  if (c.trades) lines.push('股票成交會更新持倉與交割帳戶餘額，同一批成交請勿重複匯入。');
  if (c.unmatched) lines.push(c.unmatched + ' 筆記帳沒指定付款方式（先記「現金」、不扣帳戶）：按「付款方式套用」可一次選信用卡 / 帳戶。');
  lines.push('△ 的筆會照預覽內容匯入（類別對不到的先放「其他」，可按「逐筆調整」改，或之後在 web 改）。');
  return lines.join('\n');
}

function tgImportKeyboard_(token, rows) {
  var c = tgImportCounts_(rows);
  var kb = [];
  if (c.ok > 0) {
    kb.push([
      { text: '確認匯入 ' + c.ok + ' 筆', callback_data: 'imp:ok:' + token },
      { text: '取消', callback_data: 'imp:no:' + token },
    ]);
  } else {
    kb.push([{ text: '關閉', callback_data: 'imp:no:' + token }]);
  }
  var tools = [];
  if (c.ledger > 0) tools.push({ text: '付款方式套用' + (c.unmatched ? '（' + c.unmatched + ' 筆未指定）' : ''), callback_data: 'imp:pm:' + token });
  if (rows.length > 0) tools.push({ text: '逐筆調整', callback_data: 'imp:row:' + token + ':0' });
  if (tools.length) kb.push(tools);
  return { inline_keyboard: kb };
}

/** 付款方式候選鍵盤；rowIndex 為 null 時是「套用到全部」 */
function tgImportPaymentKeyboard_(token, options, rowIndex) {
  var rows = [];
  var line = [];
  options.forEach(function (o, idx) {
    var data = rowIndex == null
      ? 'imp:pms:' + token + ':' + idx + ':' + importShortHash_(o.paymentMethod + '|' + (o.accountId || ''))
      : 'imp:rps:' + token + ':' + rowIndex + ':' + idx + ':' + importShortHash_(o.paymentMethod + '|' + (o.accountId || ''));
    if (tgCallbackBytes_(data) > TG_CALLBACK_MAX_BYTES_) return;
    line.push({ text: o.label.slice(0, 40), callback_data: data });
    if (line.length === 2) { rows.push(line); line = []; }
  });
  if (line.length) rows.push(line);
  rows.push([{ text: '返回', callback_data: rowIndex == null ? 'imp:pv:' + token : 'imp:row:' + token + ':' + rowIndex }]);
  return { inline_keyboard: rows };
}

function tgImportCategoryKeyboard_(token, rowIndex, kind, ctx) {
  var type = kind === 'income' ? 'income' : 'expense';
  var rows = [];
  var line = [];
  ctx.categories.filter(function (c) { return c.type === type; }).forEach(function (c) {
    var data = 'imp:rcs:' + token + ':' + rowIndex + ':' + c.key;
    if (tgCallbackBytes_(data) > TG_CALLBACK_MAX_BYTES_) return;
    line.push({ text: c.name, callback_data: data });
    if (line.length === 3) { rows.push(line); line = []; }
  });
  if (line.length) rows.push(line);
  rows.push([{ text: '返回', callback_data: 'imp:row:' + token + ':' + rowIndex }]);
  return { inline_keyboard: rows };
}

function tgImportRowText_(pending, i) {
  var rows = pending.rows;
  var row = rows[i];
  var lines = ['逐筆調整 ' + (i + 1) + ' / ' + rows.length, ''];
  lines.push(importRowSummary_(row));
  if (row.kind !== 'trade') {
    var r = row.resolved;
    lines.push('');
    lines.push('類別：' + r.categoryName + (r.categoryKey ? '（' + r.categoryKey + '）' : ''));
    lines.push('付款方式：' + (r.paymentMethod || '—') + (r.accountName ? '，扣 / 入帳戶 ' + r.accountName : '，不扣帳戶') + (r.paymentMatched ? '' : '（來源沒指定或對不到）'));
    if (r.tags && r.tags.length) lines.push('標籤：' + r.tags.join('、'));
  } else if (!row.resolved.accountId) {
    lines.push('');
    lines.push('沒有交割帳戶，按「改交割帳戶」選一個才會匯入。');
  }
  if (row.hard) { lines.push(''); lines.push('這筆有無法修正的錯誤，不會匯入。'); }
  lines.push('');
  lines.push('改完按「回預覽」再確認匯入。');
  return lines.join('\n');
}

function tgImportRowKeyboard_(token, i, rows) {
  var row = rows[i];
  var kb = [];
  var edit = [];
  if (row.kind !== 'trade') edit.push({ text: '改類別', callback_data: 'imp:rc:' + token + ':' + i });
  edit.push({ text: row.kind === 'trade' ? '改交割帳戶' : '改付款方式', callback_data: 'imp:rp:' + token + ':' + i });
  if (!row.hard) edit.push({ text: row.excluded ? '納入' : '排除', callback_data: 'imp:rt:' + token + ':' + i });
  kb.push(edit);
  var nav = [];
  if (i > 0) nav.push({ text: '‹ 上一筆', callback_data: 'imp:row:' + token + ':' + (i - 1) });
  if (i < rows.length - 1) nav.push({ text: '下一筆 ›', callback_data: 'imp:row:' + token + ':' + (i + 1) });
  if (nav.length) kb.push(nav);
  kb.push([{ text: '回預覽', callback_data: 'imp:pv:' + token }]);
  return { inline_keyboard: kb };
}

// ───────────────────────── /ai、檔案、多筆文字的選單 ─────────────────────────

/** /ai <原始文字>：Claude 轉 JSON → 同一條預覽流程 */
function tgImportAiFromText_(text) {
  var t = String(text || '').trim();
  if (!t) return '用法：/ai <券商成交通知 / 信用卡明細 / 收據文字 / 口語描述>';
  var res = parseImport({ text: t });
  if (!res.ok) return 'Claude 轉換失敗：' + String(res.error || '').slice(0, 120);
  return tgImportFromText_(res.json, 'Claude');
}

/** 傳 .json / .txt 檔給 bot：下載後當 /import 處理 */
function tgImportFromDocument_(doc) {
  var name = String(doc.file_name || '');
  var mime = String(doc.mime_type || '');
  var isText = /\.(json|txt)$/i.test(name) || mime === 'application/json' || mime === 'text/plain';
  if (!isText) return '只接受 .json 或 .txt 檔（RMoney 匯入格式）。';
  if (Number(doc.file_size || 0) > 512 * 1024) return '檔案太大（上限 512KB）。';
  var info = tgApi_('getFile', { file_id: doc.file_id });
  var filePath = info && info.ok && info.result && info.result.file_path;
  if (!filePath) return '無法下載檔案，請改成直接貼 JSON。';
  var token = PROP.getProperty('TG_BOT_TOKEN');
  var resp = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + token + '/' + filePath, { muteHttpExceptions: true });
  if (resp.getResponseCode() >= 400) return '下載檔案失敗（' + resp.getResponseCode() + '）。';
  return tgImportFromText_(resp.getContentText('UTF-8'), '檔案 ' + name, { allowPartial: false });
}

/**
 * 多行 / 多筆的自由文字（券商通知、明細轉貼）：先問要怎麼處理，不要直接當一筆記帳。
 * 條件：≥ 3 個非空行，或 ≥ 2 行且 ≥ 2 個金額，或超過 160 字。
 */
function tgLooksLikeBulkText_(text) {
  var t = String(text || '').trim();
  if (!t || t.charAt(0) === '/') return false;
  var lines = t.split(/\r?\n/).filter(function (l) { return l.trim(); });
  var amounts = (t.match(/\d[\d,]*(?:\.\d+)?/g) || []).filter(function (x) { return x.replace(/,/g, '').length >= 2; });
  return lines.length >= 3 || (lines.length >= 2 && amounts.length >= 2) || t.length > 160;
}

function tgOfferImportChoice_(text) {
  var token = tgImportNewToken_();
  tgImportCache_().put(TG_PROMPT_RAW_PREFIX_ + token, String(text), TG_IMPORT_TTL_SEC_);
  var lines = String(text).split(/\r?\n/).filter(function (l) { return l.trim(); }).length;
  var msg = '這段有 ' + lines + ' 行，看起來不只一筆。要怎麼處理？\n'
    + '· Claude 轉匯入：站內 Claude 直接轉成多筆，先預覽再確認（計 AI 用量）\n'
    + '· 產生提示詞：不花 API 費，拿去 ChatGPT / Claude 跑出 JSON 再貼回來\n'
    + '· 當一筆記帳：照快速記帳處理（只取一個金額）';
  var kb = { inline_keyboard: [
    [{ text: 'Claude 轉匯入', callback_data: 'imp:ai:' + token }, { text: '產生提示詞', callback_data: 'imp:pr:' + token }],
    [{ text: '當一筆記帳', callback_data: 'imp:qe:' + token }, { text: '取消', callback_data: 'imp:no:' + token }],
  ] };
  var sent = sendTelegramWithMarkup_(msg, kb);
  if (!sent.ok) sendTelegram(msg);
  return TG_REPLY_SENT_;
}

// ───────────────────────── callbacks ─────────────────────────

/** inline keyboard：imp:<op>:... */
function tgHandleImportCallback_(cq, parts, updateId) {
  var chatId = String((cq.message && cq.message.chat && cq.message.chat.id) || '');
  var messageId = cq.message && cq.message.message_id;
  var op = parts[1];
  var token = parts[2] || '';
  var cache = tgImportCache_();
  var key = TG_IMPORT_CACHE_PREFIX_ + token;
  var originalText = String((cq.message && cq.message.text) || '');
  var done = function (name, extra) {
    var out = { ok: true, updateId: updateId, callback: name };
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return jsonResponse_(out);
  };

  // ── 分段貼上 ──
  if (op === 'part') {
    var partial = cache.get(TG_IMPORT_PART_KEY_);
    if (token === 'no' || !partial) {
      cache.remove(TG_IMPORT_PART_KEY_);
      tgAnswerCallback_(cq.id, partial ? '已取消' : '沒有進行中的分段');
      tgEditMessage_(chatId, messageId, originalText + '\n→ 已取消', null);
      return done('part-cancel');
    }
    tgAnswerCallback_(cq.id, '用目前的內容解析…');
    tgEditMessage_(chatId, messageId, originalText + '\n→ 用目前收到的內容繼續', null);
    var partReply = tgImportFromText_(partial, '分段貼上', { allowPartial: false });
    if (partReply !== TG_REPLY_SENT_) sendTelegram(partReply);
    return done('part-use');
  }

  // ── 原始文字的三個去路（/prompt 的「改用站內 Claude」、多筆文字選單）──
  if (op === 'ai' || op === 'pr' || op === 'qe') {
    var rawText = cache.get(TG_PROMPT_RAW_PREFIX_ + token);
    if (!rawText) {
      tgAnswerCallback_(cq.id, '內容已過期，請重新貼一次');
      return done('raw-expired');
    }
    if (op === 'ai') {
      tgAnswerCallback_(cq.id, 'Claude 轉換中…');
      var aiReply = tgImportAiFromText_(rawText);
      if (aiReply !== TG_REPLY_SENT_) sendTelegram(aiReply);
      return done('raw-ai');
    }
    if (op === 'pr') {
      tgAnswerCallback_(cq.id, '');
      var prReply = tgImportPromptReply_(rawText);
      if (prReply !== TG_REPLY_SENT_) sendTelegram(prReply);
      return done('raw-prompt');
    }
    tgAnswerCallback_(cq.id, '記帳中…');
    tgEditMessage_(chatId, messageId, originalText + '\n→ 當作一筆快速記帳', null);
    var qeReply = tgQuickEntry_(rawText);
    if (qeReply !== TG_REPLY_SENT_) sendTelegram(qeReply);
    return done('raw-quick-entry');
  }

  if (op === 'no') {
    cache.remove(key);
    tgAnswerCallback_(cq.id, '已取消');
    tgEditMessage_(chatId, messageId, originalText + '\n→ 已取消，沒有寫入任何資料', null);
    return done('import-cancel');
  }

  var pending = tgImportLoadPending_(token);
  if (!pending) {
    tgAnswerCallback_(cq.id, '預覽已過期');
    tgEditMessage_(chatId, messageId, originalText + '\n→ 預覽已過期（1 小時），請重新貼一次', null);
    return done('import-expired');
  }
  var rows = pending.rows;

  if (op === 'ok') {
    // 先移除 cache，避免連點兩次寫兩遍
    cache.remove(key);
    tgAnswerCallback_(cq.id, '匯入中…');
    var results = importApply_(rows, pending.owner);
    var created = results.filter(function (r) { return r.outcome === 'created'; }).length;
    var skipped = results.filter(function (r) { return r.outcome === 'skipped'; }).length;
    var failed = results.filter(function (r) { return r.outcome === 'failed'; });
    var summary = '→ 已匯入 ' + created + ' 筆' + (skipped ? '，略過 ' + skipped + ' 筆已存在' : '') + (failed.length ? '，' + failed.length + ' 筆失敗' : '');
    if (failed.length) summary += '\n' + failed.slice(0, 5).map(function (f) { return '  ✗ ' + (f.message || '失敗'); }).join('\n');
    tgEditMessage_(chatId, messageId, tgImportPreviewText_(pending) + '\n' + summary, null);
    return done('import-apply', { created: created, skipped: skipped, failed: failed.length });
  }

  if (op === 'pv') {
    tgAnswerCallback_(cq.id, '');
    tgEditMessage_(chatId, messageId, tgImportPreviewText_(pending), tgImportKeyboard_(token, rows));
    return done('import-preview');
  }

  var ctx = null;
  var loadCtx = function () { if (!ctx) ctx = importLoadContext_(pending.owner); return ctx; };

  // ── 付款方式套用到全部（沒指定的；全都指定了就套全部）──
  if (op === 'pm') {
    var c = tgImportCounts_(rows);
    var options = importPaymentOptions_(loadCtx(), 'expense');
    if (!options.length) { tgAnswerCallback_(cq.id, '還沒有任何帳戶或支付方式，請先到 web 設定'); return done('pm-empty'); }
    tgAnswerCallback_(cq.id, '');
    var scope = c.unmatched ? '套用到 ' + c.unmatched + ' 筆沒指定付款方式的記帳' : '套用到全部 ' + c.ledger + ' 筆記帳';
    tgEditMessage_(chatId, messageId, tgImportPreviewText_(pending) + '\n\n→ 選一個付款方式，' + scope + '（收入不會套到信用卡）：', tgImportPaymentKeyboard_(token, options, null));
    return done('pm-menu');
  }
  if (op === 'pms') {
    var idx = parseInt(parts[3], 10);
    var options2 = importPaymentOptions_(loadCtx(), 'expense');
    var opt = options2[idx];
    if (!opt || importShortHash_(opt.paymentMethod + '|' + (opt.accountId || '')) !== parts[4]) {
      tgAnswerCallback_(cq.id, '清單已變動，請重選');
      tgEditMessage_(chatId, messageId, tgImportPreviewText_(pending), tgImportKeyboard_(token, rows));
      return done('pm-stale');
    }
    var cnt = tgImportCounts_(rows);
    var applied = 0;
    rows.forEach(function (row) {
      if (row.kind === 'trade' || row.excluded) return;
      if (cnt.unmatched && row.resolved.paymentMatched) return;
      var o = opt;
      // 收入不能進信用卡：改用同名但不扣帳戶（或改成現金）
      if (row.kind === 'income') {
        var incomeOpts = importPaymentOptions_(loadCtx(), 'income');
        var sameName = incomeOpts.filter(function (x) { return x.paymentMethod === opt.paymentMethod; })[0];
        if (!sameName) return;
        o = sameName;
      }
      if (importSetRowPayment_(row, o)) applied += 1;
    });
    tgImportSavePending_(token, pending);
    tgAnswerCallback_(cq.id, '已套用到 ' + applied + ' 筆：' + opt.paymentMethod);
    tgEditMessage_(chatId, messageId, tgImportPreviewText_(pending), tgImportKeyboard_(token, rows));
    return done('pm-apply', { applied: applied });
  }

  // ── 逐筆調整 ──
  var i = parseInt(parts[3], 10);
  if (isNaN(i) || i < 0 || i >= rows.length) {
    tgAnswerCallback_(cq.id, '這筆不存在');
    return done('row-missing');
  }
  var row = rows[i];
  if (op === 'row') {
    tgAnswerCallback_(cq.id, '');
    tgEditMessage_(chatId, messageId, tgImportRowText_(pending, i), tgImportRowKeyboard_(token, i, rows));
    return done('row-view');
  }
  if (op === 'rc') {
    tgAnswerCallback_(cq.id, '');
    tgEditMessage_(chatId, messageId, tgImportRowText_(pending, i) + '\n→ 選一個類別', tgImportCategoryKeyboard_(token, i, row.kind, loadCtx()));
    return done('row-cat-menu');
  }
  if (op === 'rcs') {
    var catKey = parts.slice(4).join(':');
    if (!importSetRowCategory_(row, catKey, loadCtx())) {
      tgAnswerCallback_(cq.id, '類別不存在');
      return done('row-cat-bad');
    }
    tgImportSavePending_(token, pending);
    tgAnswerCallback_(cq.id, '已改為 ' + row.resolved.categoryName);
    tgEditMessage_(chatId, messageId, tgImportRowText_(pending, i), tgImportRowKeyboard_(token, i, rows));
    return done('row-cat-set');
  }
  if (op === 'rp') {
    var rpOptions = importPaymentOptions_(loadCtx(), row.kind);
    if (!rpOptions.length) { tgAnswerCallback_(cq.id, '沒有可用的帳戶 / 支付方式'); return done('row-pm-empty'); }
    tgAnswerCallback_(cq.id, '');
    tgEditMessage_(chatId, messageId, tgImportRowText_(pending, i) + '\n→ 選一個' + (row.kind === 'trade' ? '交割帳戶' : '付款方式'), tgImportPaymentKeyboard_(token, rpOptions, i));
    return done('row-pm-menu');
  }
  if (op === 'rps') {
    var ridx = parseInt(parts[4], 10);
    var ropts = importPaymentOptions_(loadCtx(), row.kind);
    var ropt = ropts[ridx];
    if (!ropt || importShortHash_(ropt.paymentMethod + '|' + (ropt.accountId || '')) !== parts[5]) {
      tgAnswerCallback_(cq.id, '清單已變動，請重選');
      tgEditMessage_(chatId, messageId, tgImportRowText_(pending, i), tgImportRowKeyboard_(token, i, rows));
      return done('row-pm-stale');
    }
    if (!importSetRowPayment_(row, ropt)) {
      tgAnswerCallback_(cq.id, '這個選項不能用在這筆');
      return done('row-pm-bad');
    }
    tgImportSavePending_(token, pending);
    tgAnswerCallback_(cq.id, '已改為 ' + ropt.paymentMethod);
    tgEditMessage_(chatId, messageId, tgImportRowText_(pending, i), tgImportRowKeyboard_(token, i, rows));
    return done('row-pm-set');
  }
  if (op === 'rt') {
    if (row.hard) { tgAnswerCallback_(cq.id, '這筆有錯誤，本來就不會匯入'); return done('row-toggle-hard'); }
    row.excluded = !row.excluded;
    tgImportSavePending_(token, pending);
    tgAnswerCallback_(cq.id, row.excluded ? '已排除' : '已納入');
    tgEditMessage_(chatId, messageId, tgImportRowText_(pending, i), tgImportRowKeyboard_(token, i, rows));
    return done('row-toggle');
  }

  tgAnswerCallback_(cq.id, '');
  return jsonResponse_({ ok: true, skipped: 'unknown-import-op' });
}

// ───────────────────────── /prompt：產生給外部模型的提示詞 ─────────────────────────
var TG_PROMPT_RAW_PREFIX_ = 'tgimpraw:';
/** Telegram 單則訊息 4096 字；HTML 標籤與說明文字另外佔空間，超過就改傳檔案 */
var TG_PROMPT_MAX_INLINE_ = 3500;
/** inline 按鈕 URL 太長 Telegram 會拒絕整則訊息；超過就不放「一鍵開啟」按鈕，只能複製 */
var TG_PROMPT_OPEN_URL_MAX_ = 6000;

function tgEscapeHtml_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * /prompt <內容>：回一段「規則 + 內容」的完整提示詞。
 *  - 短的用 <pre> 包起來（手機長按 → 複製），長的改傳 rmoney-prompt.txt
 *  - 附「在 ChatGPT 開啟」「在 Claude 開啟」（URL 預填提示詞；Gemini 沒有預填連結）
 *  - 附「改用站內 Claude 直接轉換」：原始內容先存 cache，按了就走 /ai 的流程
 */
function tgImportPromptReply_(text) {
  var content = String(text || '').trim();
  var base = buildImportPrompt_({ fenced: true });
  var full = content ? base + '\n' + content : base;
  var intro = content
    ? '把下面整段貼到 Claude / ChatGPT / Gemini（長按程式碼區塊即可複製）。模型回的 JSON 用它的「複製」按鈕複製後直接貼回這裡，就會進入匯入預覽；太長被切成幾則也沒關係，我會自動接起來。'
    : '這是基礎提示詞（已含你的類別 key、帳戶與支付方式名稱）。建議存成 Claude Project / Custom GPT / Gemini Gem 的指令，之後只要把券商通知、明細或一句話丟給它，再把 JSON 貼回這裡。';

  var rows = [];
  var enc = encodeURIComponent(full);
  if (enc.length <= TG_PROMPT_OPEN_URL_MAX_) {
    rows.push([
      { text: '在 ChatGPT 開啟', url: 'https://chatgpt.com/?q=' + enc },
      { text: '在 Claude 開啟', url: 'https://claude.ai/new?q=' + enc },
    ]);
  }
  if (content) {
    var token = tgImportNewToken_();
    tgImportCache_().put(TG_PROMPT_RAW_PREFIX_ + token, content, TG_IMPORT_TTL_SEC_);
    rows.push([{ text: '改用站內 Claude 直接轉換', callback_data: 'imp:ai:' + token }]);
  }
  var markup = rows.length ? { inline_keyboard: rows } : undefined;

  if (full.length <= TG_PROMPT_MAX_INLINE_) {
    var html = tgEscapeHtml_(intro) + '\n\n<pre>' + tgEscapeHtml_(full) + '</pre>';
    var sent = tgApi_('sendMessage', {
      chat_id: PROP.getProperty('TG_CHAT_ID'), text: html, parse_mode: 'HTML',
      disable_web_page_preview: true, reply_markup: markup,
    });
    if (!sent.ok) {
      // HTML 失敗（極少數字元）→ 純文字再送一次
      var plain = sendTelegramWithMarkup_(intro + '\n\n' + full, markup);
      if (!plain.ok) sendTelegram(intro + '\n\n' + full);
    }
  } else {
    var ok = tgSendDocument_('rmoney-prompt.txt', full, intro + '\n（提示詞較長，改成附檔；開啟後全選複製）', markup);
    if (!ok) sendTelegram('提示詞太長無法送出，請到 web「記帳 → AI 匯入」按「複製提示詞」。');
  }
  return TG_REPLY_SENT_;
}

/** 傳文字檔（multipart）；reply_markup 要 JSON 字串 */
function tgSendDocument_(name, content, caption, replyMarkup) {
  var token = PROP.getProperty('TG_BOT_TOKEN');
  var chatId = PROP.getProperty('TG_CHAT_ID');
  if (!token || !chatId) return false;
  var payload = {
    chat_id: String(chatId),
    caption: String(caption || '').slice(0, 1000),
    document: Utilities.newBlob(content, 'text/plain', name),
  };
  if (replyMarkup) payload.reply_markup = JSON.stringify(replyMarkup);
  var resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendDocument', {
    method: 'post', muteHttpExceptions: true, payload: payload,
  });
  if (resp.getResponseCode() >= 400) {
    console.warn('tgSendDocument_ failed', resp.getResponseCode(), resp.getContentText().slice(0, 200));
    return false;
  }
  return true;
}
