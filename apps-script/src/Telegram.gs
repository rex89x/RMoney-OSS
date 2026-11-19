/**
 * Telegram Bot API wrapper
 * - Bot token & chat id stored in Script Properties
 */

/**
 * Telegram sendMessage 限制：
 *   - text 上限 4096 chars（含 emoji surrogate）→ 我們截在 3900 留一點 buffer
 *   - 同 chat 速率約 ~1 msg/sec、群組 ~20 msg/min
 *   - 429: 應 honor retry_after；我們做最多 2 次退避，再失敗就放棄並記 console
 * 回傳統一 shape：{ ok, error?, status?, chatId? }
 */
function sendTelegram(message, parseMode) {
  return sendTelegramToChat_(PROP.getProperty('TG_CHAT_ID'), message, parseMode);
}

/**
 * 同 sendTelegram，但指定 chatId（共同帳本成員各自綁定的 chat，見 HouseholdTelegram.gs）。
 * chatId 一律當 string 處理（pitfall #18）。
 */
function sendTelegramToChat_(chatId, message, parseMode) {
  var token = PROP.getProperty('TG_BOT_TOKEN');
  if (!token) return { ok: false, error: 'TG_BOT_TOKEN-not-set' };
  if (!chatId) return { ok: false, error: 'TG_CHAT_ID-not-set' };
  chatId = String(chatId);
  var chatIdMasked = String(chatId).replace(/^(.{2}).*(.{2})$/, '$1***$2');

  var safeText = String(message == null ? '' : message);
  if (safeText.length > 3900) {
    safeText = safeText.slice(0, 3900) + '\n…(訊息過長已截斷)';
  }

  var url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  var payload = {
    chat_id: chatId,
    text: safeText,
    disable_web_page_preview: true,
  };
  if (parseMode) payload.parse_mode = parseMode;
  var encoded = Object.keys(payload).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(payload[k]);
  }).join('&');

  // 最多 3 次：原始 + 兩次退避（針對 429）
  for (var attempt = 0; attempt < 3; attempt++) {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      muteHttpExceptions: true,
      contentType: 'application/x-www-form-urlencoded',
      payload: encoded,
    });
    var code = resp.getResponseCode();
    var body = resp.getContentText();
    if (code < 400) {
      return { ok: true, chatId: chatIdMasked, status: code };
    }
    var desc = '';
    var retryAfter = 0;
    try {
      var j = JSON.parse(body);
      if (j && j.description) desc = j.description;
      if (j && j.parameters && j.parameters.retry_after) {
        retryAfter = parseInt(j.parameters.retry_after, 10) || 0;
      }
    } catch (ignoredErr) { console.warn('[Telegram:65] ignored', ignoredErr); }
    // 429 / Bandwidth quota → 退避；其他 4xx/5xx 立刻放棄
    if (code === 429 || /quota|rate/i.test(desc)) {
      var sleepMs = Math.min(30000, Math.max(1000, retryAfter * 1000 || (1000 << attempt)));
      console.warn('Telegram backoff ' + sleepMs + 'ms attempt=' + attempt + ' code=' + code + ' desc=' + desc);
      Utilities.sleep(sleepMs);
      continue;
    }
    console.error('Telegram send failed', code, body);
    return { ok: false, error: 'telegram-' + code + (desc ? ': ' + desc : '') };
  }
  return { ok: false, error: 'telegram-rate-limited-after-retries' };
}

function sendTelegramTest() {
  return sendTelegram('[Personal Hub] test ping — ' + new Date().toISOString());
}

/**
 * 不發訊息，只回傳 bot 基本資訊 + 最近 getUpdates 的 chat 列表，
 * 用來排查 `chat not found` 類錯誤（通常是 TG_CHAT_ID 沒對上或使用者尚未對 bot /start）。
 */
function telegramDiag() {
  var token = PROP.getProperty('TG_BOT_TOKEN');
  var chatId = PROP.getProperty('TG_CHAT_ID');
  if (!token) return { ok: false, error: 'TG_BOT_TOKEN-not-set' };

  var out = { ok: true, hasChatIdProp: !!chatId, chatIdPropValue: chatId || null };

  try {
    var me = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getMe', { muteHttpExceptions: true });
    out.getMe = JSON.parse(me.getContentText());
  } catch (err) {
    out.getMeError = String(err);
  }

  try {
    var upd = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true });
    var updJson = JSON.parse(upd.getContentText());
    var recent = (updJson.result || []).slice(-10).map(function (u) {
      var m = u.message || u.edited_message || u.channel_post || {};
      var chat = m.chat || {};
      return { chatId: chat.id, type: chat.type, title: chat.title, username: chat.username, firstName: chat.first_name };
    });
    out.recentChats = recent;
    out.recentCount = (updJson.result || []).length;
  } catch (err) {
    out.getUpdatesError = String(err);
  }

  return out;
}

function formatAlertMessage_(alert, triggerValue) {
  var label = alert.type === 'fx' ? 'FX Alert' : 'Stock Alert';
  var target = alert.target || '';
  var dir = alert.direction || '';
  var threshold = alert.threshold;
  var metric = alert.metric || 'price';
  var ts = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
  var lines = ['[' + label + '] ' + target, '--------------------'];
  var v = typeof triggerValue === 'number' ? Math.round(triggerValue * 100) / 100 : triggerValue;
  switch (metric) {
    case 'ma':
      lines.push((dir === 'above' ? '站上' : '跌破') + ' ' + threshold + ' 日均線（距均線 ' + (v >= 0 ? '+' : '') + v + '%）');
      break;
    case 'high52w':
      lines.push('創 52 週新高');
      break;
    case 'low52w':
      lines.push('創 52 週新低');
      break;
    case 'vsCost':
      lines.push('距平均成本 ' + (v >= 0 ? '+' : '') + v + '%（門檻 ' + (dir === 'above' ? '≥' : '≤') + ' ' + threshold + '%）');
      break;
    case 'weight':
      lines.push('持倉佔比 ' + v + '%（門檻 ' + (dir === 'above' ? '≥' : '≤') + ' ' + threshold + '%）');
      break;
    case 'rsi14':
      lines.push('RSI(14) ' + v + '（門檻 ' + (dir === 'above' ? '≥' : '≤') + ' ' + threshold + '）');
      break;
    default:
      lines.push('Value    : ' + v + ' (' + dir + ')');
      lines.push('Threshold: ' + threshold);
  }
  if (alert.type === 'stock' && metric !== 'price') {
    try {
      var stock = fsGetDoc_('stocks/' + target);
      if (stock && stock.currentPrice) lines.push('現價     : ' + stock.currentPrice);
    } catch (ignoredErr) { console.warn('[Telegram:154] ignored', ignoredErr); }
  }
  lines.push('Time     : ' + ts, '--------------------');
  return lines.join('\n');
}

/**
 * 通用 Bot API 呼叫（JSON body）。給 inline keyboard / callback / editMessage 用。
 * 回傳 { ok, result?, error? }；不 throw，呼叫端自行判斷。
 */
function tgApi_(method, payload) {
  var token = PROP.getProperty('TG_BOT_TOKEN');
  if (!token) return { ok: false, error: 'TG_BOT_TOKEN-not-set' };
  var resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
  });
  var code = resp.getResponseCode();
  var body = resp.getContentText();
  var json = null;
  try { json = JSON.parse(body); } catch (ignoredErr) { console.warn('[Telegram:176] ignored', ignoredErr); }
  if (code >= 400 || !json || !json.ok) {
    console.warn('tgApi_ ' + method + ' failed', code, body.slice(0, 200));
    return { ok: false, error: 'telegram-' + code + (json && json.description ? ': ' + json.description : '') };
  }
  return { ok: true, result: json.result };
}

/** 送訊息並附 inline keyboard；replyMarkup 形如 { inline_keyboard: [[{text, callback_data}]] } */
function sendTelegramWithMarkup_(message, replyMarkup) {
  var chatId = PROP.getProperty('TG_CHAT_ID');
  if (!chatId) return { ok: false, error: 'TG_CHAT_ID-not-set' };
  var safeText = String(message == null ? '' : message);
  if (safeText.length > 3900) safeText = safeText.slice(0, 3900) + '\n…(訊息過長已截斷)';
  return tgApi_('sendMessage', {
    chat_id: chatId,
    text: safeText,
    disable_web_page_preview: true,
    reply_markup: replyMarkup || undefined,
  });
}

function tgAnswerCallback_(callbackQueryId, text) {
  return tgApi_('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || undefined });
}

/** 改既有訊息的文字與 keyboard（replyMarkup 傳 null 會移除按鈕） */
function tgEditMessage_(chatId, messageId, text, replyMarkup) {
  var payload = { chat_id: chatId, message_id: messageId, text: String(text || ''), disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  else payload.reply_markup = { inline_keyboard: [] };
  return tgApi_('editMessageText', payload);
}
