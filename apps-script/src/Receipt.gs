/**
 * 收據 OCR — Claude（fast tier）看圖片，回傳結構化的記帳欄位。
 *
 * Body: { imageBase64: string, mimeType: 'image/webp' | 'image/jpeg' | 'image/png' }
 * Response: { ok, receipt: { amount, currency, date, merchant, category, items[], confidence } }
 *
 * 類別 key 只從使用者的 categories 挑；猜不到給 other。金額為總計（含稅 / 服務費）。
 */
function parseReceipt(body) {
  var b64 = body && body.imageBase64;
  var mime = (body && body.mimeType) || 'image/jpeg';
  if (!b64 || typeof b64 !== 'string') return { ok: false, error: 'missing imageBase64' };
  if (b64.length > 6 * 1024 * 1024) return { ok: false, error: 'image too large' };
  if (['image/webp', 'image/jpeg', 'image/png', 'image/gif'].indexOf(mime) === -1) mime = 'image/jpeg';

  var ctx = tgLoadEntryContext_();
  var catLines = ctx.categories
    .filter(function (c) { return c.type === 'expense'; })
    .map(function (c) { return c.key + ' = ' + c.name; }).join('\n');
  var todayTW = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');

  var prompt = [
    '這是一張收據 / 發票 / 帳單的照片。請抽出記帳需要的欄位，只回傳 JSON：',
    '{"amount": 數字, "currency": "TWD|USD|JPY|EUR|IDR", "date": "yyyy-MM-dd", "merchant": "店名", "category": "類別 key", "items": ["品項1", "品項2"], "confidence": 0到1}',
    '',
    '規則：',
    '- amount 取最終應付總額（含稅、服務費、折扣後）。台灣發票取「總計」。',
    '- 日期看不到就用今天 ' + todayTW + '；民國年要換算（113 → 2024）。',
    '- currency：台灣收據 TWD；有 ¥/円 → JPY；$ 且美國店 → USD；預設 TWD。',
    '- merchant 用店名 / 品牌，不要地址、統編。',
    '- category 只能是下列 key，都不像就 other：',
    catLines || 'other = 其他',
    '- items 最多 8 個，簡短。',
    '- 看不清楚的欄位給合理猜測並降低 confidence。',
  ].join('\n');

  var parsed;
  try {
    parsed = callClaudeJson_({
      feature: 'receiptOcr', tier: 'fast', effort: 'low', maxTokens: 4000,
      prompt: prompt, images: [{ mediaType: mime, data: b64 }],
    }).json;
  } catch (err) {
    console.error('[parseReceipt]', err);
    return { ok: false, error: String(err && err.message || err), raw: err && err.raw };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'llm output not json' };

  var allowed = {};
  ctx.categories.forEach(function (c) { if (c.type === 'expense') allowed[c.key] = true; });
  var currency = String(parsed.currency || 'TWD').toUpperCase();
  if (['TWD', 'USD', 'JPY', 'EUR', 'IDR'].indexOf(currency) === -1) currency = 'TWD';
  var date = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date || '')) ? parsed.date : todayTW;
  return {
    ok: true,
    receipt: {
      amount: Math.abs(parseFloat(parsed.amount)) || 0,
      currency: currency,
      date: date,
      merchant: String(parsed.merchant || '').trim().slice(0, 60),
      category: allowed[parsed.category] ? parsed.category : 'other',
      items: Array.isArray(parsed.items) ? parsed.items.slice(0, 8).map(function (s) { return String(s).slice(0, 40); }) : [],
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    },
  };
}
