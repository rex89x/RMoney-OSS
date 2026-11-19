/**
 * 寬鬆 JSON 修復（Apps Script 版）— 與前端 `features/import/json-repair.ts` 同一套邏輯，改一邊要改另一邊。
 *
 * 處理 LLM / 聊天軟體常見的壞 JSON：彎引號 “ ” ‘ ’、單引號 / Python dict（None、True）、
 * 字串裡沒跳脫的雙引號、尾逗號、// 註解、沒加引號的 key、全形 ｛｝［］：，、字串內換行、
 * 數字千分位，以及被 Telegram 4096 字切斷的內容（回報 truncated 並補結尾）。
 *
 * importRepairJson_(text) → { text, truncated }
 * importParseJsonLoosely_(full, cut) → { ok, data, repaired, truncated } | { ok: false, error, truncated }
 */
var IMPORT_DQUOTES_ = '"“”„‟″〝〞＂';
var IMPORT_SQUOTES_ = "'‘’‚‛′＇";
var IMPORT_FULLWIDTH_ = { '｛': '{', '｝': '}', '［': '[', '］': ']', '：': ':', '，': ',' };
var IMPORT_ESCAPES_ = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"', "'": "'" };
var IMPORT_WORD_LITERALS_ = {
  'true': 'true', 'false': 'false', 'null': 'null',
  True: 'true', False: 'false', None: 'null', nil: 'null', undefined: 'null', NaN: 'null', Infinity: 'null',
};

function importIsWs_(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ' ' || c === '　' || c === '﻿';
}
function importIsWordChar_(c) {
  return /[A-Za-z0-9_$一-鿿぀-ヿ]/.test(c);
}
function importStructural_(c) {
  return IMPORT_FULLWIDTH_[c] || c;
}

function importRepairJson_(input) {
  var s = String(input == null ? '' : input);
  var n = s.length;
  var i = 0;
  var out = '';
  var stack = [];
  var last = 'start'; // start | open | close | ':' | ',' | value

  function expectingKey() {
    return stack[stack.length - 1] === '{' && (last === 'open' || last === ',');
  }
  function skipWsAndComments() {
    while (i < n) {
      var c = s.charAt(i);
      if (importIsWs_(c)) { i += 1; continue; }
      if (c === '/' && s.charAt(i + 1) === '/') { while (i < n && s.charAt(i) !== '\n') i += 1; continue; }
      if (c === '/' && s.charAt(i + 1) === '*') { var e = s.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      break;
    }
  }
  function readString(opener, asKey) {
    var closers = IMPORT_DQUOTES_.indexOf(opener) >= 0 ? IMPORT_DQUOTES_ : IMPORT_SQUOTES_;
    i += 1;
    var buf = '';
    while (i < n) {
      var c = s.charAt(i);
      if (c === '\\') {
        var nx = s.charAt(i + 1);
        if (!nx) { i += 1; break; }
        if (nx === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
          buf += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        buf += IMPORT_ESCAPES_.hasOwnProperty(nx) ? IMPORT_ESCAPES_[nx] : nx;
        i += 2;
        continue;
      }
      if (closers.indexOf(c) >= 0) {
        // 真的結尾還是字串裡的引號？看後面第一個非空白字元
        var j = i + 1;
        while (j < n && importIsWs_(s.charAt(j))) j += 1;
        var nxt = j < n ? importStructural_(s.charAt(j)) : '';
        var closes = nxt === ''
          || (asKey ? nxt === ':' : (nxt === ',' || nxt === '}' || nxt === ']'))
          || (!asKey && (IMPORT_DQUOTES_.indexOf(nxt) >= 0 || IMPORT_SQUOTES_.indexOf(nxt) >= 0));
        if (closes) { i += 1; return buf; }
        buf += c;
        i += 1;
        continue;
      }
      if (c === '\n' || c === '\r') {
        if (buf && buf.charAt(buf.length - 1) !== ' ') buf += ' ';
        i += 1;
        continue;
      }
      buf += c;
      i += 1;
    }
    return buf;
  }
  function readWord() {
    var start = i;
    while (i < n && importIsWordChar_(s.charAt(i))) i += 1;
    return s.slice(start, i);
  }
  function readNumber() {
    var start = i;
    i += 1;
    while (i < n && /[0-9._eE+-]/.test(s.charAt(i))) i += 1;
    var raw = s.slice(start, i).replace(/_/g, '').replace(/^\+/, '');
    while (s.charAt(i) === ',' && /^\d{3}(?![\d])/.test(s.slice(i + 1, i + 5))) {
      raw += s.slice(i + 1, i + 4);
      i += 4;
    }
    if (raw.charAt(0) === '.') raw = '0' + raw;
    if (raw.charAt(raw.length - 1) === '.') raw = raw.slice(0, -1);
    var num = Number(raw);
    return isFinite(num) ? String(num) : 'null';
  }
  function emitValue(token) {
    if (last === 'value' || last === 'close') out += ',';
    out += token;
    last = 'value';
  }

  while (i < n) {
    skipWsAndComments();
    if (i >= n) break;
    var raw = s.charAt(i);
    var c = importStructural_(raw);
    if (c === '{' || c === '[') {
      if (last === 'value' || last === 'close') out += ',';
      stack.push(c);
      out += c;
      last = 'open';
      i += 1;
      continue;
    }
    if (c === '}' || c === ']') {
      if (last === ',') out = out.replace(/,$/, '');
      if (last === ':') out += 'null';
      var open = stack.pop();
      out += open === '[' ? ']' : open === '{' ? '}' : c;
      last = 'close';
      i += 1;
      if (!stack.length) break; // 最外層收完就停，後面的說明文字不理
      continue;
    }
    if (c === ',') {
      if (last !== ',' && last !== 'open' && last !== ':') { out += ','; last = ','; }
      i += 1;
      continue;
    }
    if (c === ':') {
      if (last !== ':') { out += ':'; last = ':'; }
      i += 1;
      continue;
    }
    if (IMPORT_DQUOTES_.indexOf(raw) >= 0 || IMPORT_SQUOTES_.indexOf(raw) >= 0) {
      var asKey = expectingKey();
      emitValue(JSON.stringify(readString(raw, asKey)));
      continue;
    }
    var next = s.charAt(i + 1);
    if (/[0-9]/.test(c) || ((c === '-' || c === '+' || c === '.') && /[0-9.]/.test(next))) {
      emitValue(readNumber());
      continue;
    }
    if (importIsWordChar_(c)) {
      var word = readWord();
      if (expectingKey()) emitValue(JSON.stringify(word));
      else emitValue(IMPORT_WORD_LITERALS_.hasOwnProperty(word) ? IMPORT_WORD_LITERALS_[word] : JSON.stringify(word));
      continue;
    }
    i += 1; // 雜訊字元
  }

  var truncated = stack.length > 0;
  if (last === ',') out = out.replace(/,$/, '');
  if (last === ':') out += 'null';
  while (stack.length) {
    var o = stack.pop();
    out += o === '[' ? ']' : '}';
  }
  return { text: out, truncated: truncated };
}

/** 先標準 JSON.parse（cut），失敗才修（full） */
function importParseJsonLoosely_(full, cut) {
  if (cut == null) cut = full;
  try {
    return { ok: true, data: JSON.parse(cut), repaired: false, truncated: false };
  } catch (firstErr) {
    var fixed = importRepairJson_(full);
    try {
      return { ok: true, data: JSON.parse(fixed.text), repaired: true, truncated: fixed.truncated };
    } catch (_) {
      var msg = String(firstErr && firstErr.message || firstErr).slice(0, 80);
      return { ok: false, error: fixed.truncated ? msg + '（內容似乎被截斷，括號沒有收完）' : msg, truncated: fixed.truncated };
    }
  }
}

/** 文字看起來是 JSON 的開頭（容許前面的彎引號 / 全形括號 / ``` 圍欄） */
function importLooksLikeJsonStart_(text) {
  var t = String(text || '').trim();
  if (t.indexOf('```') === 0) return true;
  // 去掉前面的引號雜訊（聊天軟體轉貼常包一層 “ ”）
  var k = 0;
  while (k < t.length && (IMPORT_DQUOTES_.indexOf(t.charAt(k)) >= 0 || IMPORT_SQUOTES_.indexOf(t.charAt(k)) >= 0 || importIsWs_(t.charAt(k)))) k += 1;
  var c = importStructural_(t.charAt(k));
  return c === '{' || c === '[';
}
