/**
 * Itinerary generator via Claude API (Claude.gs)
 * Body: { tripId, preferences: { destination, startDate, endDate, budget, interests, pace, musts, avoid } }
 */

function generateItinerary(body) {
  if (!body || !body.preferences) {
    return { ok: false, error: 'missing preferences' };
  }
  var p = body.preferences;
  var prompt = buildItineraryPrompt_(p);
  var parsed;
  var model;
  try {
    var res = callClaudeJson_({
      feature: 'itineraryGenerate', tier: 'default', effort: 'medium', maxTokens: 16000, prompt: prompt,
    });
    parsed = res.json;
    model = res.model;
  } catch (err) {
    console.error('[generateItinerary]', err);
    return { ok: false, error: String(err && err.message || err), raw: err && err.raw };
  }

  // Enrich items with place coords (best-effort)
  if (parsed.days) {
    parsed.days.forEach(function (day) {
      (day.items || []).forEach(function (item) {
        if (item.placeName) {
          try {
            var place = geocodePlace_inner_(item.placeName + ' ' + (item.address || ''));
            if (place) {
              item.placeId = place.placeId;
              item.lat = place.lat;
              item.lng = place.lng;
              if (place.photoUrl) item.photoUrl = place.photoUrl;
            }
          } catch (err) {
            console.warn('geocode failed', item.placeName, err);
          }
        }
      });
    });
  }

  // Optionally persist to Firestore
  if (body.tripId) {
    saveItineraryToFirestore_(body.tripId, parsed, model);
  }

  return { ok: true, itinerary: parsed, model: model };
}

/**
 * 文字 → 行程的 AI 匯入（前端 `features/itinerary/ai-import.ts`）。
 * Body: { instruction, text }
 *  - instruction：前端 `buildBuiltinInstruction()` 產生的整理規則（含今天、既有旅程與停留點），
 *    提示詞只在前端維護一份，與巧明日常同一套規則。
 *  - text：使用者貼的原始文字。
 * 只回傳 JSON 字串、**不寫 Firestore**：驗證、分類與勾選都在前端，使用者確認後才寫。
 * 只有 owner 能呼叫（Main.gs 的 MEMBER_ALLOWED_ACTIONS_ 沒有它），受 Claude 額度控管。
 */
function parseItineraryText(body) {
  var text = body && typeof body.text === 'string' ? body.text.trim() : '';
  var instruction = body && typeof body.instruction === 'string' ? body.instruction.trim() : '';
  if (!text) return { ok: false, error: 'missing text' };
  if (!instruction) return { ok: false, error: 'missing instruction' };
  if (text.length > 20000) return { ok: false, error: 'text too long (max 20000 chars)' };
  if (instruction.length > 12000) return { ok: false, error: 'instruction too long' };
  try {
    var res = callClaude_({
      feature: 'itineraryImport', tier: 'fast', effort: 'low', maxTokens: 16000,
      system: instruction, prompt: text,
    });
    var loose = importParseJsonLoosely_(res.text);
    if (!loose.ok) return { ok: false, error: 'llm output not json', raw: res.text.slice(0, 200) };
    return { ok: true, json: loose.repaired ? JSON.stringify(loose.data) : res.text, model: res.model };
  } catch (err) {
    console.error('[parseItineraryText]', err);
    return { ok: false, error: String(err && err.message || err) };
  }
}

/**
 * 對已有行程的某天，請 LLM 補充 3~5 個建議項目（不寫 Firestore，只回傳建議讓使用者選）。
 * Body: { destination, dayTheme?, existingItems: [{startTime,title,type}], count?, avoid?, interests? }
 */
function suggestDayItems(body) {
  if (!body) return { ok: false, error: 'missing body' };

  var count = body.count || 4;
  var existing = (body.existingItems || []).map(function (it) {
    return '- ' + (it.startTime ? it.startTime + ' ' : '') + (it.title || '') + (it.type ? ' (' + it.type + ')' : '');
  }).join('\n');

  var prompt = [
    '你是一位資深旅遊規劃師。依下方條件產生 ' + count + ' 個可插入現有行程的建議項目。',
    '只回傳合法 JSON 陣列，不要任何其他文字。',
    '',
    '目的地：' + (body.destination || ''),
    '當天主題：' + (body.dayTheme || '未指定'),
    '興趣：' + ((body.interests || []).join(', ') || '未指定'),
    '避開：' + ((body.avoid || []).join(', ') || '無'),
    '已安排項目：',
    existing || '(無)',
    '',
    '輸出格式：',
    '[',
    '  {',
    '    "startTime": "HH:MM",',
    '    "endTime": "HH:MM",',
    '    "type": "transport|meal|activity|accommodation|shopping",',
    '    "title": "...",',
    '    "placeName": "...",',
    '    "estimatedCost": 0,',
    '    "currency": "TWD",',
    '    "notes": "為什麼建議"',
    '  }',
    ']',
  ].join('\n');

  var parsed;
  try {
    parsed = callClaudeJson_({
      feature: 'itinerarySuggest', tier: 'default', effort: 'low', maxTokens: 8000, prompt: prompt,
    }).json;
  } catch (err) {
    console.error('[suggestDayItems]', err);
    return { ok: false, error: String(err && err.message || err), raw: err && err.raw };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'expected array', raw: parsed };

  return { ok: true, suggestions: parsed };
}

/**
 * 用使用者 prompt + trip / itinerary context 請 Claude 產出 markdown 筆記。
 * 不寫 Firestore — 由前端決定 append / replace（避免覆寫使用者手寫內容）。
 *
 * Body: { tripId, prompt, tone? }
 */
function generateTripNotes(body) {
  if (!body || !body.tripId || !body.prompt) {
    return { ok: false, error: 'missing tripId or prompt' };
  }

  var trip = null;
  try { trip = fsGetDoc_('trips/' + body.tripId); }
  catch (err) { console.warn('generateTripNotes get trip', err); }
  var itinerary = null;
  try { itinerary = fsGetDoc_('itineraries/' + body.tripId); }
  catch (err) { console.warn('generateTripNotes get itinerary', err); }

  // 摘要 days / items（總長度截 2000 字內）
  var dayLines = [];
  try {
    var days = fsListDocs_('itineraries/' + body.tripId + '/days', 30);
    days.sort(function (a, b) {
      return String(a._name || '').localeCompare(String(b._name || ''));
    });
    days.forEach(function (d, di) {
      var dayId = (d._name || '').split('/').pop();
      dayLines.push('- Day ' + (di + 1) + ' (' + (d.date || dayId) + ')'
        + (d.theme ? ' ' + d.theme : ''));
      try {
        var items = fsListDocs_('itineraries/' + body.tripId + '/days/' + dayId + '/items', 30);
        items.forEach(function (it) {
          var line = '  · ' + (it.startTime ? it.startTime + ' ' : '') + (it.title || '');
          if (it.placeName) line += ' @ ' + it.placeName;
          dayLines.push(line);
        });
      } catch (err) { console.warn('generateTripNotes items', dayId, err); }
    });
  } catch (err) { console.warn('generateTripNotes days', err); }

  var context = dayLines.join('\n');
  if (context.length > 2000) context = context.slice(0, 2000) + '\n...（已截斷）';

  var destination = '';
  if (trip && Array.isArray(trip.destination)) destination = trip.destination.join(', ');
  else if (itinerary && itinerary.destination) destination = itinerary.destination;

  var promptParts = [
    '你是一位旅遊筆記助手，請根據下方旅程資訊與使用者要求產出 Markdown 格式的筆記。',
    '',
    '輸出規範：',
    '- 直接輸出 Markdown，不要包在 ``` 區塊裡，也不要任何前後解釋文字。',
    '- 可使用標題 (##)、清單、表格、checklist。',
    '- 不要插入 raw HTML。',
    '- 全文使用繁體中文。',
    '',
    '旅程資訊：',
    '- 旅程名稱：' + ((trip && trip.name) || (itinerary && itinerary.title) || ''),
    '- 目的地：' + destination,
    '- 日期：' + ((trip && trip.startDate ? formatTsDate_(trip.startDate) : (itinerary && itinerary.startDate) || '')
      + ' ~ ' + (trip && trip.endDate ? formatTsDate_(trip.endDate) : (itinerary && itinerary.endDate) || '')),
    '- 預算：' + ((trip && trip.budget) || '未指定') + ' TWD',
    '',
    '行程概要：',
    context || '(尚無 day items)',
    '',
    '寫作風格：' + (body.tone || '輕鬆、實用、條列式'),
    '',
    '使用者要求：',
    body.prompt,
  ];

  var text;
  var model;
  try {
    var res = callClaude_({
      feature: 'tripNotes', tier: 'default', effort: 'low', maxTokens: 8000, prompt: promptParts.join('\n'),
    });
    text = res.text;
    model = res.model;
  } catch (err) {
    console.error('[generateTripNotes]', err);
    return { ok: false, error: String(err && err.message || err) };
  }
  if (!text) return { ok: false, error: 'empty response' };
  // 萬一 LLM 還是包 ``` 進來，去掉外層
  text = text.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  return { ok: true, markdown: text, model: model };
}

function formatTsDate_(v) {
  if (!v) return '';
  try {
    if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
    if (typeof v === 'string') return v.slice(0, 10);
    if (v.seconds) return Utilities.formatDate(new Date(v.seconds * 1000), 'Asia/Taipei', 'yyyy-MM-dd');
  } catch (_e) { /* ignore */ }
  return String(v);
}

function buildItineraryPrompt_(p) {
  var interests = (p.interests || []).join(', ');
  var musts = (p.musts || []).join(', ');
  var avoid = (p.avoid || []).join(', ');
  return [
    '你是一位資深旅遊規劃師。依以下條件產出行程，只回傳合法 JSON，不要任何其他文字。',
    '',
    '使用者偏好：',
    '- 目的地：' + (p.destination || ''),
    '- 日期：' + (p.startDate || '') + ' ~ ' + (p.endDate || ''),
    '- 預算：' + (p.budget || '未指定') + ' TWD',
    '- 興趣：' + interests,
    '- 步調：' + (p.pace || 'balanced'),
    '- 必去：' + musts,
    '- 忌口/不想去：' + avoid,
    '',
    '輸出格式：',
    '{',
    '  "summary": "...",',
    '  "days": [',
    '    {',
    '      "date": "YYYY-MM-DD",',
    '      "theme": "...",',
    '      "items": [',
    '        {',
    '          "order": 1,',
    '          "startTime": "HH:MM",',
    '          "endTime": "HH:MM",',
    '          "type": "transport|meal|activity|accommodation|shopping",',
    '          "title": "...",',
    '          "placeName": "...",',
    '          "address": "...",',
    '          "estimatedCost": 0,',
    '          "currency": "TWD",',
    '          "notes": "..."',
    '        }',
    '      ]',
    '    }',
    '  ],',
    '  "tips": ["...", "..."]',
    '}',
  ].join('\n');
}

function saveItineraryToFirestore_(tripId, data, model) {
  var itinRef = 'itineraries/' + tripId;
  fsSetDoc_(itinRef, {
    tripId: tripId,
    title: data.summary || ('Itinerary ' + tripId),
    summary: data.summary || '',
    tips: data.tips || [],
    generatedByLLM: true,
    llmModel: model || claudeModelFor_('default'),
    updatedAt: new Date(),
  }, true);

  (data.days || []).forEach(function (day, di) {
    var dayId = 'day-' + (di + 1);
    fsSetDoc_(itinRef + '/days/' + dayId, {
      date: day.date || '',
      theme: day.theme || '',
    }, true);
    (day.items || []).forEach(function (item, ii) {
      var itemId = 'item-' + (ii + 1);
      fsSetDoc_(itinRef + '/days/' + dayId + '/items/' + itemId, Object.assign({
        order: ii + 1,
        status: 'planned',
      }, item), true);
    });
  });
}

// -------- Places helpers --------

function geocodePlace(params) {
  var query = params && params.q;
  if (!query) return { ok: false, error: 'missing q' };
  var result = geocodePlace_inner_(query);
  return result ? { ok: true, result: result } : { ok: false, error: 'not-found' };
}

function geocodePlace_inner_(query) {
  var key = PROP.getProperty('GOOGLE_MAPS_API_KEY');
  if (!key) return null;
  // `place_id:ChIJ...` → Place Details（findplacefromtext 不認 place_id 前綴）
  var placeIdMatch = /^place_id:([A-Za-z0-9_-]+)/i.exec(String(query));
  if (placeIdMatch) {
    return placeDetailsByPlaceId_(placeIdMatch[1], key);
  }
  var url = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json'
    + '?input=' + encodeURIComponent(query)
    + '&inputtype=textquery'
    + '&fields=place_id,name,formatted_address,geometry,photos'
    + '&key=' + encodeURIComponent(key);
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return null;
  var data = JSON.parse(resp.getContentText());
  var c = (data.candidates || [])[0];
  if (!c) return null;
  var photoUrl = null;
  if (c.photos && c.photos[0]) {
    photoUrl = 'https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference='
      + c.photos[0].photo_reference + '&key=' + key;
  }
  return {
    placeId: c.place_id,
    name: c.name,
    address: c.formatted_address,
    lat: c.geometry && c.geometry.location && c.geometry.location.lat,
    lng: c.geometry && c.geometry.location && c.geometry.location.lng,
    photoUrl: photoUrl,
  };
}

function placeDetailsByPlaceId_(placeId, key) {
  if (!placeId || !key) return null;
  var url = 'https://maps.googleapis.com/maps/api/place/details/json'
    + '?place_id=' + encodeURIComponent(placeId)
    + '&fields=place_id,name,formatted_address,geometry,photos'
    + '&key=' + encodeURIComponent(key);
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return null;
  var data = JSON.parse(resp.getContentText());
  var r = data && data.result;
  if (!r) return null;
  var photoUrl = null;
  if (r.photos && r.photos[0]) {
    photoUrl = 'https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference='
      + r.photos[0].photo_reference + '&key=' + key;
  }
  return {
    placeId: r.place_id,
    name: r.name,
    address: r.formatted_address,
    lat: r.geometry && r.geometry.location && r.geometry.location.lat,
    lng: r.geometry && r.geometry.location && r.geometry.location.lng,
    photoUrl: photoUrl,
  };
}

/**
 * 展開 Google Maps 短網址（maps.app.goo.gl / goo.gl/maps / app.goo.gl）並解析座標 + 地點名。
 *
 * 海外（無 google 登入 cookie）常見的麻煩：
 *   1. 短網址 302 到 consent.google.com/m?continue=<真正 URL>… 要從 `continue` 取真實 URL。
 *   2. 短網址有時直接回 200 HTML 預覽頁，要從 `<link rel="canonical">` / `og:url`
 *      或 og:image 等 meta 取座標 / 真實 URL。
 *   3. 純文字 query (`?q=東京タワー`)、`?api=1&query=…`、`place_id:` 引用都要 fallback geocode。
 */
function resolveGoogleMapsUrl(params) {
  var url = params && params.url;
  if (!url) return { ok: false, error: 'missing url' };
  url = String(url).trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };

  var follow = followMapsRedirects_(url);
  if (!follow.ok) return { ok: false, error: follow.error };
  var finalUrl = follow.url;
  var bodyText = follow.body || '';

  // 1. 直接從 final URL 嘗試解析（含座標 / place name / place_id）
  var parsed = parseGoogleMapsUrlGAS_(finalUrl);

  // 2. 如果 final URL 不是地圖網址（被擋在 consent / preview 頁），從 body 撈 canonical/og:url
  if ((!parsed || (parsed.lat == null && !parsed.name && !parsed.placeId)) && bodyText) {
    var canonical = extractCanonicalMapsUrl_(bodyText);
    if (canonical) {
      finalUrl = canonical;
      parsed = parseGoogleMapsUrlGAS_(canonical) || parsed;
    }
  }
  // 3. body 的 og:image 或 staticmap 也可能含 center=LAT,LNG，可以救一波
  if ((!parsed || parsed.lat == null) && bodyText) {
    var fromBody = extractCoordsFromBody_(bodyText);
    if (fromBody) {
      parsed = parsed || {};
      parsed.lat = fromBody.lat;
      parsed.lng = fromBody.lng;
    }
  }

  if (parsed && parsed.lat != null && parsed.lng != null) {
    var enrichQuery = parsed.name || (parsed.placeId ? 'place_id:' + parsed.placeId : '');
    var enriched = enrichQuery ? geocodePlace_inner_(enrichQuery) : null;
    return {
      ok: true,
      result: {
        lat: parsed.lat,
        lng: parsed.lng,
        name: parsed.name || (enriched && enriched.name) || null,
        address: enriched && enriched.address || null,
        placeId: parsed.placeId || (enriched && enriched.placeId) || null,
        photoUrl: enriched && enriched.photoUrl || null,
        mapsUrl: finalUrl,
      },
    };
  }

  // 4. 拿不到座標 → 用 name / place_id fallback geocode
  var fallbackQuery = (parsed && parsed.name) || (parsed && parsed.placeId ? 'place_id:' + parsed.placeId : '');
  if (fallbackQuery) {
    var hit = geocodePlace_inner_(fallbackQuery);
    if (hit && hit.lat != null && hit.lng != null) {
      return {
        ok: true,
        result: {
          lat: hit.lat,
          lng: hit.lng,
          name: hit.name || (parsed && parsed.name) || null,
          address: hit.address || null,
          placeId: hit.placeId || (parsed && parsed.placeId) || null,
          photoUrl: hit.photoUrl || null,
          mapsUrl: finalUrl,
        },
      };
    }
  }

  return { ok: false, error: 'could-not-parse', finalUrl: finalUrl };
}

/**
 * 跟最多 6 次重導向，並處理 consent.google.com 攔截：當 final URL 落在 consent host 上時，
 * 從 `continue` query 抽出真正的目的網址繼續展開。最後一次抓 body 給 caller 從 HTML 解析。
 */
function followMapsRedirects_(startUrl) {
  var finalUrl = startUrl;
  var body = '';
  try {
    for (var i = 0; i < 6; i++) {
      // consent.google.com 即使有 cookie 也常回 200，直接跳過用 continue
      var continued = extractContinueParam_(finalUrl);
      if (continued) {
        finalUrl = continued;
        continue;
      }
      var resp = UrlFetchApp.fetch(finalUrl, {
        followRedirects: false,
        muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
            + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        },
      });
      var code = resp.getResponseCode();
      if (code >= 300 && code < 400) {
        var headers = resp.getAllHeaders ? resp.getAllHeaders() : resp.getHeaders();
        var loc = headers && (headers.Location || headers.location);
        if (!loc) break;
        finalUrl = absolutizeUrl_(String(loc), finalUrl);
        continue;
      }
      // 200 / 其他 — 抓 body 給上層 fallback
      try { body = resp.getContentText() || ''; } catch (_e) { body = ''; }
      break;
    }
  } catch (err) {
    console.warn('followMapsRedirects_', err);
    return { ok: false, error: 'follow-redirect-failed: ' + (err && err.message || err) };
  }
  return { ok: true, url: finalUrl, body: body };
}

function extractContinueParam_(url) {
  if (!url) return null;
  // 只在落在 consent / interstitial 主機才動，避免誤吃 search query 裡的 continue
  if (!/(^https?:\/\/[^/]*consent\.google\.|\/\/[^/]+\/sorry\/|gstatic\.com\/consent)/i.test(url)) return null;
  var m = /[?&](?:continue|q)=([^&]+)/i.exec(url);
  if (!m) return null;
  try {
    var decoded = decodeURIComponent(m[1]);
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch (_e) { /* ignore */ }
  return null;
}

function absolutizeUrl_(loc, base) {
  if (/^https?:\/\//i.test(loc)) return loc;
  // protocol-relative
  if (/^\/\//.test(loc)) return 'https:' + loc;
  // root-relative — 接到 base 的 origin
  var origin = /^(https?:\/\/[^/]+)/i.exec(base);
  if (loc.charAt(0) === '/' && origin) return origin[1] + loc;
  return loc;
}

function extractCanonicalMapsUrl_(html) {
  if (!html) return null;
  // og:url / canonical / al:web:url 都試一遍
  var patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']al:web:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']al:android:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']al:ios:url["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = patterns[i].exec(html);
    if (m && m[1]) {
      var href = m[1].replace(/&amp;/g, '&');
      if (/(google\.com\/maps|maps\.google\.|maps\.app\.goo\.gl|comgooglemaps:)/i.test(href)) {
        return href;
      }
    }
  }
  return null;
}

function extractCoordsFromBody_(html) {
  if (!html) return null;
  var coordRe = /-?\d+(?:\.\d+)?/.source;
  // staticmap / og:image 常見 center=LAT,LNG 或 markers=color:…|LAT,LNG
  var patterns = [
    new RegExp('[?&]center=(' + coordRe + '),(' + coordRe + ')', 'i'),
    new RegExp('[?&]ll=(' + coordRe + '),(' + coordRe + ')', 'i'),
    new RegExp('[?&]q=(' + coordRe + '),(' + coordRe + ')', 'i'),
    new RegExp('!3d(' + coordRe + ')!4d(' + coordRe + ')', 'i'),
    new RegExp('"latitude":\\s*(' + coordRe + ')[^}]+"longitude":\\s*(' + coordRe + ')', 'i'),
    new RegExp('"lat":\\s*(' + coordRe + ')[^}]+"lng":\\s*(' + coordRe + ')', 'i'),
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = patterns[i].exec(html);
    if (m) {
      var lat = Number(m[1]);
      var lng = Number(m[2]);
      if (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return { lat: lat, lng: lng };
      }
    }
  }
  return null;
}

function parseGoogleMapsUrlGAS_(url) {
  if (!url) return null;
  var coordRe = /-?\d+(?:\.\d+)?/.source;

  var m = new RegExp('/maps/place/([^/?]+)/@(' + coordRe + '),(' + coordRe + ')', 'i').exec(url);
  if (m) {
    return { name: decodeUriSafe_(m[1]), lat: Number(m[2]), lng: Number(m[3]) };
  }
  var m2 = new RegExp('/maps/place/([^/?]+).*?!3d(' + coordRe + ')!4d(' + coordRe + ')', 'i').exec(url);
  if (m2) {
    return { name: decodeUriSafe_(m2[1]), lat: Number(m2[2]), lng: Number(m2[3]) };
  }
  // /maps/search/?api=1&query=LAT,LNG (新版分享 / API 連結)
  var m3 = new RegExp('[?&](?:q|ll|center|query|destination|origin|viewpoint)=(' + coordRe + '),(' + coordRe + ')', 'i').exec(url);
  if (m3) {
    var nameFromQuery = extractPlaceNameFromUrl_(url);
    return { name: nameFromQuery, lat: Number(m3[1]), lng: Number(m3[2]) };
  }
  var m4 = new RegExp('@(' + coordRe + '),(' + coordRe + ')', 'i').exec(url);
  if (m4) {
    return { name: extractPlaceNameFromUrl_(url), lat: Number(m4[1]), lng: Number(m4[2]) };
  }
  // place_id 引用 — 上層可以用 geocode by place_id 救
  var m5 = /[?&](?:query_place_id|destination_place_id|origin_place_id|cid)=([^&]+)/i.exec(url);
  if (m5) {
    return { name: extractPlaceNameFromUrl_(url), placeId: decodeUriSafe_(m5[1]) };
  }
  var m6 = /place_id:([A-Za-z0-9_-]+)/i.exec(url);
  if (m6) {
    return { name: extractPlaceNameFromUrl_(url), placeId: m6[1] };
  }
  // /maps/place/<name> 沒座標
  var m7 = /\/maps\/place\/([^/?]+)/i.exec(url);
  if (m7) {
    return { name: decodeUriSafe_(m7[1]) };
  }
  // /maps/search/?api=1&query=<text> 或 ?q=<text>
  var m8 = extractPlaceNameFromUrl_(url);
  if (m8) return { name: m8 };
  return null;
}

function extractPlaceNameFromUrl_(url) {
  if (!url) return null;
  var coordRe = /-?\d+(?:\.\d+)?/.source;
  var m = /[?&](?:q|query|destination|origin)=([^&]+)/i.exec(url);
  if (!m) return null;
  var raw = decodeUriSafe_(m[1]);
  if (!raw) return null;
  // 純座標、純 place_id 引用就不要當 name
  if (new RegExp('^' + coordRe + ',\\s*' + coordRe + '$').test(raw)) return null;
  if (/^place_id:/i.test(raw)) return null;
  return raw;
}

function decodeUriSafe_(s) {
  if (!s) return null;
  try { return decodeURIComponent(String(s).replace(/\+/g, ' ')).trim() || null; }
  catch (_e) { return String(s).replace(/\+/g, ' ').trim() || null; }
}

function placesSearch(params) {
  var query = params && params.q;
  if (!query) return { ok: false, error: 'missing q' };
  var key = PROP.getProperty('GOOGLE_MAPS_API_KEY');
  if (!key) return { ok: false, error: 'maps key missing' };
  var url = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
    + '?query=' + encodeURIComponent(query)
    + '&key=' + encodeURIComponent(key);
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return { ok: false, error: 'http ' + resp.getResponseCode() };
  var data = JSON.parse(resp.getContentText());
  var results = (data.results || []).slice(0, 10).map(function (r) {
    return {
      placeId: r.place_id,
      name: r.name,
      address: r.formatted_address,
      lat: r.geometry && r.geometry.location.lat,
      lng: r.geometry && r.geometry.location.lng,
      rating: r.rating,
    };
  });
  return { ok: true, results: results };
}

// -------- 營業時間（Place Details opening_hours）--------

/** CacheService 上限就是 6 小時（21600 秒） */
var PLACE_DETAILS_CACHE_SECONDS_ = 21600;
var PLACE_DETAILS_FIELDS_ = 'place_id,opening_hours,utc_offset_minutes,business_status,url';

/**
 * 行程項目營業時間：Body { placeId }。
 * 用 Places API Place Details（legacy）只要 opening_hours / utc_offset_minutes / business_status / url，
 * 結果在 Script Cache 放 6 小時，避免同一地點被重複計費。前端會把結果存回 item.openingHours。
 */
function placeDetails(params) {
  var placeId = params && params.placeId ? String(params.placeId).trim() : '';
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) return { ok: false, error: 'invalid placeId' };
  var cache = CacheService.getScriptCache();
  var cacheKey = 'placeDetails:' + placeId;
  var cached = null;
  try { cached = cache.get(cacheKey); } catch (e) { console.warn('placeDetails cache get failed', e); }
  if (cached) {
    try { return { ok: true, result: JSON.parse(cached), cached: true }; }
    catch (e) { console.warn('placeDetails cache parse failed', e); }
  }
  var key = PROP.getProperty('GOOGLE_MAPS_API_KEY');
  if (!key) return { ok: false, error: 'maps key missing' };
  var url = 'https://maps.googleapis.com/maps/api/place/details/json'
    + '?place_id=' + encodeURIComponent(placeId)
    + '&fields=' + encodeURIComponent(PLACE_DETAILS_FIELDS_)
    + '&language=zh-TW'
    + '&key=' + encodeURIComponent(key);
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return { ok: false, error: 'http ' + resp.getResponseCode() };
  var data = JSON.parse(resp.getContentText());
  if (!data || data.status !== 'OK' || !data.result) {
    return { ok: false, error: 'places ' + ((data && data.status) || 'UNKNOWN') + (data && data.error_message ? ': ' + data.error_message : '') };
  }
  var result = normalizePlaceDetails_(data.result, placeId);
  try { cache.put(cacheKey, JSON.stringify(result), PLACE_DETAILS_CACHE_SECONDS_); }
  catch (e) { console.warn('placeDetails cache put failed', e); }
  return { ok: true, result: result, cached: false };
}

/** Place Details result → 前端 ItemOpeningHours 形狀（periods 只留 day / time，過濾掉壞資料） */
function normalizePlaceDetails_(r, placeId) {
  var oh = r && r.opening_hours;
  var periods = [];
  if (oh && Array.isArray(oh.periods)) {
    for (var i = 0; i < oh.periods.length; i++) {
      var p = oh.periods[i];
      var open = normalizePeriodPoint_(p && p.open);
      if (!open) continue;
      var close = normalizePeriodPoint_(p && p.close);
      periods.push(close ? { open: open, close: close } : { open: open });
    }
  }
  return {
    placeId: (r && r.place_id) || placeId,
    businessStatus: (r && r.business_status) || null,
    utcOffsetMinutes: r && typeof r.utc_offset_minutes === 'number' ? r.utc_offset_minutes : null,
    url: (r && r.url) || null,
    weekdayText: oh && Array.isArray(oh.weekday_text) ? oh.weekday_text.map(String) : [],
    periods: periods,
    hasHours: Boolean(oh),
  };
}

function normalizePeriodPoint_(pt) {
  if (!pt || typeof pt.day !== 'number' || pt.day < 0 || pt.day > 6) return null;
  var time = String(pt.time || '');
  if (!/^\d{4}$/.test(time)) return null;
  return { day: pt.day, time: time };
}
