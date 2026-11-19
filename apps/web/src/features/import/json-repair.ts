/**
 * 把 LLM / 聊天軟體弄壞的「差一點就是 JSON」文字修回合法 JSON。
 *
 * 實際遇過的狀況（都是引號惹的禍）：
 *  - 彎引號 “ ” ‘ ’：ChatGPT 網頁把回覆當散文渲染、iOS「智慧標點」、Telegram 轉貼
 *  - 單引號字串 / Python dict：{'kind': 'expense', 'note': None, 'prepaid': True}
 *  - 字串裡沒跳脫的雙引號："note": "買 "可樂" 兩瓶"
 *  - 尾逗號、// 註解、沒加引號的 key、全形 ｛｝［］：，
 *  - 字串中直接換行、數字帶千分位或 + 號
 *  - 被 Telegram 4096 字切斷（回報 truncated，讓呼叫端決定要不要等下一段）
 *
 * 做法是一個小型 tokenizer 把內容重新輸出成標準 JSON；不是完整 parser，修不好就讓 JSON.parse 報錯。
 * Apps Script 端有一份同邏輯的 ES5 版本（`apps-script/src/ImportJson.gs`），改這裡要一起改。
 */

export interface RepairedJson {
  text: string;
  /** 括號沒收完（通常是訊息被截斷）；text 已自動補上結尾 */
  truncated: boolean;
}

const DOUBLE_QUOTES = new Set(['"', '“', '”', '„', '‟', '″', '〝', '〞', '＂']);
const SINGLE_QUOTES = new Set(["'", '‘', '’', '‚', '‛', '′', '＇']);
const FULLWIDTH: Record<string, string> = { '｛': '{', '｝': '}', '［': '[', '］': ']', '：': ':', '，': ',' };
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"', "'": "'" };
const WORD_LITERALS: Record<string, string> = {
  true: 'true', false: 'false', null: 'null',
  True: 'true', False: 'false', None: 'null', nil: 'null', undefined: 'null', NaN: 'null', Infinity: 'null',
};

function isWs(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ' ' || c === '　' || c === '﻿';
}
function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_$一-鿿぀-ヿ]/.test(c);
}
function isNumStart(c: string, next: string): boolean {
  return /[0-9]/.test(c) || ((c === '-' || c === '+' || c === '.') && /[0-9.]/.test(next));
}

/** 全形括號 / 標點只在字串外才換成半形；字串內（備註）原樣保留 */
function structural(c: string): string {
  return FULLWIDTH[c] ?? c;
}

export function repairJson(input: string): RepairedJson {
  const s = input;
  const n = s.length;
  let i = 0;
  let out = '';
  const stack: Array<'{' | '['> = [];
  // 上一個輸出的 token 類型，用來判斷「現在是 key 的位置嗎」與尾逗號
  let last: 'open' | 'close' | ':' | ',' | 'value' | 'start' = 'start';

  const expectingKey = (): boolean => stack[stack.length - 1] === '{' && (last === 'open' || last === ',');

  function skipWsAndComments(): void {
    while (i < n) {
      const c = s.charAt(i);
      if (isWs(c)) { i += 1; continue; }
      if (c === '/' && s.charAt(i + 1) === '/') { while (i < n && s.charAt(i) !== '\n') i += 1; continue; }
      if (c === '/' && s.charAt(i + 1) === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      break;
    }
  }

  /** 讀一個字串（任何一種引號開頭），回傳內容；i 停在結尾引號之後 */
  function readString(opener: string, asKey: boolean): string {
    const closers = DOUBLE_QUOTES.has(opener) ? DOUBLE_QUOTES : SINGLE_QUOTES;
    i += 1;
    let buf = '';
    while (i < n) {
      const c = s.charAt(i);
      if (c === '\\') {
        const nx = s.charAt(i + 1);
        if (!nx) { i += 1; break; }
        if (nx === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
          buf += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        buf += ESCAPES[nx] ?? nx;
        i += 2;
        continue;
      }
      if (closers.has(c)) {
        // 這個引號是真的結尾，還是字串裡面的引號？看後面第一個非空白字元：
        // key 後面應該是 :，value 後面應該是 , } ] 或結束；否則就是夾在內容裡的引號，當一般字元。
        let j = i + 1;
        while (j < n && isWs(s.charAt(j))) j += 1;
        const nxt = j < n ? structural(s.charAt(j)) : '';
        const closes = nxt === ''
          || (asKey ? nxt === ':' : (nxt === ',' || nxt === '}' || nxt === ']'))
          // 連續兩個 key/value（漏逗號）也當結尾，讓後面的邏輯補逗號
          || (!asKey && (DOUBLE_QUOTES.has(nxt) || SINGLE_QUOTES.has(nxt)));
        if (closes) { i += 1; return buf; }
        buf += c;
        i += 1;
        continue;
      }
      if (c === '\n' || c === '\r') {
        // 字串裡的換行：合法 JSON 不允許，改成空白
        if (buf && !buf.endsWith(' ')) buf += ' ';
        i += 1;
        continue;
      }
      buf += c;
      i += 1;
    }
    return buf; // 沒收尾（被截斷）
  }

  function readWord(): string {
    const start = i;
    while (i < n && isWordChar(s.charAt(i))) i += 1;
    return s.slice(start, i);
  }

  function readNumber(): string {
    const start = i;
    i += 1;
    while (i < n && /[0-9._eE+-]/.test(s.charAt(i))) i += 1;
    let raw = s.slice(start, i).replace(/_/g, '').replace(/^\+/, '');
    // 千分位（1,280）：只有在逗號後緊接 3 位數字且再後面不是數字時才吃掉
    while (s.charAt(i) === ',' && /^\d{3}(?![\d])/.test(s.slice(i + 1, i + 5))) {
      raw += s.slice(i + 1, i + 4);
      i += 4;
    }
    if (raw.startsWith('.')) raw = `0${raw}`;
    if (raw.endsWith('.')) raw = raw.slice(0, -1);
    return Number.isFinite(Number(raw)) ? String(Number(raw)) : 'null';
  }

  /** 輸出一個 value / key；漏逗號（兩個 value 連在一起）→ 補上。呼叫端要自己把 last 設成 'value'（讓 TS 看得到） */
  function emitValue(token: string): void {
    if (last === 'value' || last === 'close') out += ',';
    out += token;
  }

  while (i < n) {
    skipWsAndComments();
    if (i >= n) break;
    const raw = s.charAt(i);
    const c = structural(raw);

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
      const open = stack.pop();
      // 括號種類對不上（例如 [ ... }）：照 stack 修正
      out += open === '[' ? ']' : open === '{' ? '}' : c;
      last = 'close';
      i += 1;
      // 最外層收完就停：後面的「希望這有幫助！」之類說明文字不要再解析
      if (stack.length === 0) break;
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
    if (DOUBLE_QUOTES.has(raw) || SINGLE_QUOTES.has(raw)) {
      const asKey = expectingKey();
      const str = readString(raw, asKey);
      emitValue(JSON.stringify(str));
      last = 'value';
      continue;
    }
    if (isNumStart(c, s.charAt(i + 1))) {
      emitValue(readNumber());
      last = 'value';
      continue;
    }
    if (isWordChar(c)) {
      const word = readWord();
      if (expectingKey()) {
        emitValue(JSON.stringify(word));
      } else {
        const lit = WORD_LITERALS[word];
        emitValue(lit ?? JSON.stringify(word));
      }
      last = 'value';
      continue;
    }
    // 其他雜訊字元（例如多出來的 ` 或 ）直接跳過
    i += 1;
  }

  const truncated = stack.length > 0;
  if (last === ',') out = out.replace(/,$/, '');
  if (last === ':') out += 'null';
  while (stack.length > 0) {
    const open = stack.pop();
    out += open === '[' ? ']' : '}';
  }
  return { text: out, truncated };
}
