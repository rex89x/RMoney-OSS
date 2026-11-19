/**
 * Firestore REST wrapper (using ScriptApp OAuth token — service account via default credentials,
 * or script-owner identity if running under the owning Google account with datastore scope).
 *
 * 為簡化部署：以 script owner (=owner) 身分操作 Firestore。appsscript.json 已加上 datastore scope。
 * 若未來需跨專案操作，改用 Service Account JWT → access_token。
 */

var FS_BASE_URL = 'https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents';

function fsBase_() {
  var pid = PROP.getProperty('FIREBASE_PROJECT_ID');
  if (!pid) throw new Error('FIREBASE_PROJECT_ID not set in Script Properties');
  return FS_BASE_URL.replace('{PROJECT_ID}', pid);
}

function fsToken_() {
  // Token from script user; requires datastore scope in appsscript.json
  return ScriptApp.getOAuthToken();
}

/**
 * UrlFetch + 重試：429 / 500 / 502 / 503 / 504 與網路例外最多重試 3 次（0.4s / 1.2s / 3.6s 退避）。
 * 以前任何一次瞬斷就讓整個排程失敗再觸發 notifyError（2026-11 稽核 D9）。
 */
var FS_RETRY_CODES_ = { 429: true, 500: true, 502: true, 503: true, 504: true };

function fsFetch_(url, options) {
  var attempt = 0;
  var lastErr = null;
  while (attempt < 4) {
    try {
      var resp = UrlFetchApp.fetch(url, options);
      var code = resp.getResponseCode();
      if (!FS_RETRY_CODES_[code] || attempt === 3) return resp;
      lastErr = new Error('Firestore HTTP ' + code);
    } catch (err) {
      lastErr = err;
      if (attempt === 3) throw err;
    }
    Utilities.sleep(400 * Math.pow(3, attempt));
    attempt++;
  }
  throw lastErr || new Error('fsFetch_ failed');
}

function fsRequest_(path, method, payload, queryParams) {
  var url = fsBase_() + path;
  if (queryParams) {
    var qs = Object.keys(queryParams)
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(queryParams[k]); })
      .join('&');
    if (qs) url += (url.indexOf('?') === -1 ? '?' : '&') + qs;
  }
  var options = {
    method: method,
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + fsToken_() },
    contentType: 'application/json',
  };
  if (payload) options.payload = JSON.stringify(payload);

  var resp = fsFetch_(url, options);
  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code >= 400) {
    throw new Error('Firestore ' + method + ' ' + path + ' → ' + code + ': ' + text);
  }
  return text ? JSON.parse(text) : {};
}

// -------- value encoding --------

function encodeValue_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(encodeValue_) } };
  }
  if (typeof v === 'object') {
    var fields = {};
    Object.keys(v).forEach(function (k) { fields[k] = encodeValue_(v[k]); });
    return { mapValue: { fields: fields } };
  }
  return { stringValue: String(v) };
}

function encodeFields_(obj) {
  var out = {};
  Object.keys(obj).forEach(function (k) { out[k] = encodeValue_(obj[k]); });
  return out;
}

function decodeValue_(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue_);
  if ('mapValue' in v) return decodeFields_(v.mapValue.fields || {});
  return null;
}

function decodeFields_(fields) {
  var out = {};
  Object.keys(fields || {}).forEach(function (k) { out[k] = decodeValue_(fields[k]); });
  return out;
}

// -------- CRUD --------

function fsGetDoc_(relPath) {
  // relPath e.g. "config/allowedEmails" or "stocks/2330"
  try {
    var doc = fsRequest_('/' + relPath, 'GET');
    if (!doc.fields) return null;
    var data = decodeFields_(doc.fields);
    data._name = doc.name;
    return data;
  } catch (err) {
    var msg = String(err && err.message || err);
    if (msg.indexOf('404') !== -1 || msg.indexOf('NOT_FOUND') !== -1) return null;
    throw err;
  }
}

function fsSetDoc_(relPath, data, merge) {
  // Put the update mask in the Write body instead of PATCH query parameters.
  // This avoids Google API query binding failures for `updateMask.fieldPaths`
  // while preserving PATCH-style merge/upsert semantics.
  var keys = Object.keys(data);
  if (merge && keys.length === 0) return {};

  var write = {
    update: {
      name: fsDocumentName_(relPath),
      fields: encodeFields_(data),
    },
  };
  if (merge) write.updateMask = { fieldPaths: keys };

  return fsBatchWrite_([write]);
}

function fsAddDoc_(collectionPath, data) {
  var body = { fields: encodeFields_(data) };
  return fsRequest_('/' + collectionPath, 'POST', body);
}

/**
 * 列 collection。
 * - 預設只拿第一頁（最多 pageSize 筆，Firestore 上限 300；超過會被 API 自己壓到 300）。
 * - opts.all = true 時跟著 nextPageToken 把整個 collection 拿完 —— 備份 / 匯出 / 餘額彙總 / 週期交易
 *   這類「漏一筆就錯」的地方要用 fsListAllDocs_，以前 1000 筆硬截會讓備份靜默不完整（2026-11 稽核 D3）。
 */
function fsListDocs_(collectionPath, pageSize, opts) {
  var all = !!(opts && opts.all);
  var out = [];
  var pageToken = null;
  var guard = 0;
  do {
    var qp = {};
    if (pageSize) qp.pageSize = pageSize;
    if (pageToken) qp.pageToken = pageToken;
    var resp = fsRequest_('/' + collectionPath + '?' + objToQuery_(qp), 'GET');
    (resp.documents || []).forEach(function (d) {
      var data = decodeFields_(d.fields || {});
      data._name = d.name;
      out.push(data);
    });
    pageToken = all ? (resp.nextPageToken || null) : null;
    guard++;
  } while (pageToken && guard < 500);
  return out;
}

/** 整個 collection（自動翻頁）。pageSize 只是每頁大小，預設 300。 */
function fsListAllDocs_(collectionPath, pageSize) {
  return fsListDocs_(collectionPath, pageSize || 300, { all: true });
}

function fsRunQuery_(parentPath, structuredQuery) {
  var path = parentPath ? '/' + parentPath + ':runQuery' : ':runQuery';
  var body = { structuredQuery: structuredQuery };
  var resp = fsRequest_(path, 'POST', body);
  if (!Array.isArray(resp)) return [];
  return resp
    .filter(function (r) { return r.document; })
    .map(function (r) {
      var data = decodeFields_(r.document.fields || {});
      data._name = r.document.name;
      return data;
    });
}

function fsDeleteDoc_(relPath) {
  return fsRequest_('/' + relPath, 'DELETE');
}

function objToQuery_(obj) {
  return Object.keys(obj || {})
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]); })
    .join('&');
}

function fsDocumentName_(relPath) {
  var pid = PROP.getProperty('FIREBASE_PROJECT_ID');
  if (!pid) throw new Error('FIREBASE_PROJECT_ID not set in Script Properties');
  return 'projects/' + pid + '/databases/(default)/documents/' + relPath;
}

var FS_BATCH_CHUNK_ = 450; // Firestore 單次 batchWrite 上限 500，留餘裕

function fsBatchWrite_(writes) {
  // writes: [{ update: { name, fields } }, { delete: name }, ...]
  // 超過 450 筆自動切成多次送（以前靠呼叫端自律，漏切就整批 400）。
  var pid = PROP.getProperty('FIREBASE_PROJECT_ID');
  var url = 'https://firestore.googleapis.com/v1/projects/' + pid + '/databases/(default)/documents:batchWrite';
  var merged = { writeResults: [], status: [] };
  for (var i = 0; i < writes.length; i += FS_BATCH_CHUNK_) {
    var chunk = writes.slice(i, i + FS_BATCH_CHUNK_);
    var resp = fsFetch_(url, {
      method: 'POST',
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + fsToken_() },
      contentType: 'application/json',
      payload: JSON.stringify({ writes: chunk }),
    });
    if (resp.getResponseCode() >= 400) {
      throw new Error('batchWrite failed: ' + resp.getContentText());
    }
    var parsed = JSON.parse(resp.getContentText() || '{}');
    merged.writeResults = merged.writeResults.concat(parsed.writeResults || []);
    merged.status = merged.status.concat(parsed.status || []);
  }
  return merged;
}
