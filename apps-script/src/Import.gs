/**
 * AI 匯入：把使用者貼的原始文字（券商成交通知 / 信用卡明細 / 收據 / 口語）轉成 RMoney 通用匯入 JSON。
 *
 * 規則與前端 `features/import/prompt.ts` 同一份（改格式兩邊要一起改，見 docs/AI_IMPORT_FORMAT.md）。
 * 回傳 { ok: true, json: '<字串>' }：驗證與正規化都在前端做（schema 在前端），這裡只負責叫 Claude（Claude.gs）。
 * 只有 owner 能呼叫（Main.gs 的 MEMBER_ALLOWED_ACTIONS_ 沒有它）。
 */
function parseImport(body) {
  var text = body && typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return { ok: false, error: 'missing text' };
  if (text.length > 20000) return { ok: false, error: 'text too long (max 20000 chars)' };
  try {
    var res = callClaude_({
      feature: 'aiImport', tier: 'fast', effort: 'low', maxTokens: 16000,
      system: buildImportPrompt_({ fenced: false }), prompt: text,
    });
    // 偶爾還是會夾圍欄或彎引號：先修一輪再驗
    var loose = importParseJsonLoosely_(res.text);
    if (!loose.ok) return { ok: false, error: 'llm output not json', raw: res.text.slice(0, 200) };
    return { ok: true, json: loose.repaired ? JSON.stringify(loose.data) : res.text };
  } catch (err) {
    console.error('[parseImport]', err);
    return { ok: false, error: String(err && err.message || err) };
  }
}

/**
 * 與前端 buildImportPrompt() 同一份文字（類別 / 帳戶 / 支付方式從 Firestore 讀）。
 * opts.fenced：外部聊天模型（/prompt）用 true，要求包 ```json 圍欄（聊天介面才有複製鍵、不會變彎引號）；
 * 站內 Claude 解析用 false。
 */
function buildImportPrompt_(opts) {
  var fenced = !opts || opts.fenced !== false;
  var ctx = tgLoadEntryContext_();
  var todayTW = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  var expenseCats = ctx.categories.filter(function (c) { return c.type === 'expense'; }).map(function (c) { return c.key + ' = ' + c.name; });
  var incomeCats = ctx.categories.filter(function (c) { return c.type === 'income'; }).map(function (c) { return c.key + ' = ' + c.name; });
  var ledgerTypes = ['cash', 'bank', 'credit_card', 'e_wallet_balance', 'investment_cash'];
  var tradeTypes = ['bank', 'cash', 'investment_cash', 'e_wallet_balance'];
  var paymentNames = [];
  function pushName(n) { var v = String(n || '').trim(); if (v && paymentNames.indexOf(v) < 0) paymentNames.push(v); }
  ctx.accounts.filter(function (a) { return ledgerTypes.indexOf(a.type) >= 0; }).forEach(function (a) { pushName(a.name); pushName(a.legacyPaymentMethod); });
  (ctx.paymentMethods || []).forEach(function (p) { pushName(p.name); });
  var tradeAccounts = ctx.accounts.filter(function (a) { return tradeTypes.indexOf(a.type) >= 0; }).map(function (a) { return a.name; });
  return [
    '你是記帳助理。把我接下來貼的內容（券商成交通知、信用卡 / 銀行明細、收據、或口語描述）轉成 RMoney 匯入 JSON（version 1）。'
      + (fenced ? '只回傳 JSON，放在一個 ```json 圍欄裡，圍欄前後不要有任何說明文字。' : '只回傳 JSON 本體，不要任何說明文字、不要 Markdown 圍欄。'),
    '',
    '格式：',
    '{"version": 1, "source": "你的名字（例如 chatgpt）", "items": [ ... ]}',
    '',
    'items 每一筆是以下三種之一：',
    '1. 支出：{"kind":"expense","date":"yyyy-MM-dd","amount":數字,"currency":"TWD","category":"類別key","note":"店名或說明","account":"付款方式名稱（選填）","tags":["選填"]}',
    '2. 收入：{"kind":"income","date":"yyyy-MM-dd","amount":數字,"currency":"TWD","category":"類別key","note":"說明","account":"入帳帳戶名稱（選填）"}',
    '3. 股票成交：{"kind":"trade","date":"yyyy-MM-dd","market":"TW|US","symbol":"2330 或 AAPL","side":"buy|sell","shares":數字,"price":成交單價,"currency":"TWD|USD","fee":手續費,"tax":交易稅,"account":"交割帳戶名稱（選填）","note":"選填"}',
    '',
    'JSON 寫法（最常出錯，請逐條遵守）：',
    '- key 與字串只能用半形直的雙引號 " (U+0022)。不可用單引號 \'、不可用彎引號 “ ” ‘ ’、不可用全形「：」「，」。',
    '- 字串內容本身若有引號，改用「」或直接省略；字串裡絕對不要出現 " 或 \\。字串不要換行。',
    '- 數字直接寫數字（1280、12.5），不要加引號、千分位逗號或貨幣符號。',
    '- 不要尾逗號、不要註解、不要 NaN / None / undefined；沒有的選填欄位直接省略，不要填 null。',
    '',
    '內容規則：',
    '- 日期一律 yyyy-MM-dd；沒寫日期就用今天 ' + todayTW + '；民國年要換算（113 → 2024）。',
    '- amount / price / shares 都是正數。支出的金額取最終應付總額（含稅、服務費、折扣後）。',
    '- currency 用 ISO 代碼：台幣 TWD、美金 USD、日圓 JPY、歐元 EUR、印尼盾 IDR。沒寫就是 TWD。',
    '- 台股代號是 4 位數字（market TW、currency TWD）；美股是英文代號（market US、currency USD）。買進 side=buy、賣出 side=sell。',
    '- 一筆成交通知含手續費與交易稅時分別填 fee / tax（原幣）；沒有就填 0 或省略。多筆成交要拆成多個 item。',
    '- 信用卡 / 銀行明細每一行一筆 item；退款或入帳寫成 income。',
    '- category 只能用下列 key（寫 key，不要寫中文名稱）；都不像就用 other：',
    '  支出：' + (expenseCats.join('、') || 'other = 其他'),
    '  收入：' + (incomeCats.join('、') || 'other_income = 其他收入'),
    paymentNames.length
      ? '- account（付款方式 / 帳戶）：內容有提到「刷 X / 用 X 付 / X 卡 / 從 X 扣」時，填下列其中一個完整名稱：' + paymentNames.join('、') + '。對不上或沒提到就省略。'
      : '- account 不確定就省略。',
    tradeAccounts.length ? '- 股票成交的 account（交割帳戶）可填：' + tradeAccounts.join('、') + '；不確定就省略。' : '',
    '- 同一筆資料若有券商 / 發票的單號，放進 "id" 以便去重。',
    '- 看不懂的內容略過，不要編造金額。',
    '',
    fenced ? '接下來是要轉換的內容：' : '要轉換的內容在使用者訊息裡。',
  ].filter(function (line) { return line !== ''; }).join('\n');
}
