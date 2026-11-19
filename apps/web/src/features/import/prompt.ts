import type { Account } from '@/features/accounts';
import type { Category } from '@/features/ledger/types';
import type { PaymentMethod } from '@/features/ledger/payment-method-types';
import { formatTWDateInput } from '@/lib/tz';
import { IMPORT_FORMAT_VERSION } from './schema';
import { LEDGER_ACCOUNT_TYPES, TRADE_ACCOUNT_TYPES } from './normalize';

export interface ImportPromptParams {
  categories: Category[];
  accounts: Account[];
  /** 自訂支付方式（信用卡等）；會跟帳戶一起列給模型挑 */
  paymentMethods?: PaymentMethod[];
  today?: Date;
  /**
   * 外部聊天模型（ChatGPT / Claude / Gemini 網頁）用 true：要求把 JSON 放在 ```json 圍欄裡，
   * 聊天介面才會給「複製」按鈕、且不會把引號渲染成彎引號。
   * 站內 Claude 解析用 false（圍欄會讓 JSON.parse 失敗）。
   */
  fenced?: boolean;
}

/** 付款方式候選名單：帳戶（記帳可用類型）+ 自訂支付方式，去重保序 */
export function paymentNameOptions(accounts: Account[], paymentMethods: PaymentMethod[] = []): string[] {
  const names: string[] = [];
  const push = (n: string | null | undefined) => { const v = (n ?? '').trim(); if (v && !names.includes(v)) names.push(v); };
  accounts
    .filter((a) => a.active !== false && !a.archivedAt && (LEDGER_ACCOUNT_TYPES as readonly string[]).includes(a.type))
    .forEach((a) => { push(a.name); push(a.legacyPaymentMethod); });
  paymentMethods.filter((p) => !p.archivedAt).forEach((p) => push(p.name));
  return names;
}

/**
 * 給任何 LLM 的提示詞：把原始內容（券商成交通知、信用卡明細、收據文字、口語描述）轉成 RMoney 匯入 JSON。
 * 跟 Apps Script `Import.gs` 的 `buildImportPrompt_` 同一份規則（那邊是給站內 Claude / Telegram /prompt 用）。
 * 改規則兩邊一起改。
 */
export function buildImportPrompt(params: ImportPromptParams): string {
  const today = formatTWDateInput(params.today ?? new Date());
  const fenced = params.fenced ?? true;
  const expenseCats = params.categories.filter((c) => c.type === 'expense' && !c.archivedAt).map((c) => `${c.key} = ${c.name}`);
  const incomeCats = params.categories.filter((c) => c.type === 'income' && !c.archivedAt).map((c) => `${c.key} = ${c.name}`);
  const paymentNames = paymentNameOptions(params.accounts, params.paymentMethods ?? []);
  const tradeAccounts = params.accounts.filter((a) => a.active !== false && !a.archivedAt && (TRADE_ACCOUNT_TYPES as readonly string[]).includes(a.type)).map((a) => a.name);

  return [
    `你是記帳助理。把我接下來貼的內容（券商成交通知、信用卡 / 銀行明細、收據、或口語描述）轉成 RMoney 匯入 JSON（version ${IMPORT_FORMAT_VERSION}）。`
      + (fenced ? '只回傳 JSON，放在一個 ```json 圍欄裡，圍欄前後不要有任何說明文字。' : '只回傳 JSON 本體，不要任何說明文字、不要 Markdown 圍欄。'),
    '',
    '格式：',
    `{"version": ${IMPORT_FORMAT_VERSION}, "source": "你的名字（例如 chatgpt）", "items": [ ... ]}`,
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
    `- 日期一律 yyyy-MM-dd；沒寫日期就用今天 ${today}；民國年要換算（113 → 2024）。`,
    '- amount / price / shares 都是正數。支出的金額取最終應付總額（含稅、服務費、折扣後）。',
    '- currency 用 ISO 代碼：台幣 TWD、美金 USD、日圓 JPY、歐元 EUR、印尼盾 IDR。沒寫就是 TWD。',
    '- 台股代號是 4 位數字（market TW、currency TWD）；美股是英文代號（market US、currency USD）。買進 side=buy、賣出 side=sell。',
    '- 一筆成交通知含手續費與交易稅時分別填 fee / tax（原幣）；沒有就填 0 或省略。多筆成交要拆成多個 item。',
    '- 信用卡 / 銀行明細每一行一筆 item；退款或入帳寫成 income。',
    '- category 只能用下列 key（寫 key，不要寫中文名稱）；都不像就用 other：',
    `  支出：${expenseCats.join('、') || 'other = 其他'}`,
    `  收入：${incomeCats.join('、') || 'other_income = 其他收入'}`,
    paymentNames.length > 0
      ? `- account（付款方式 / 帳戶）：內容有提到「刷 X / 用 X 付 / X 卡 / 從 X 扣」時，填下列其中一個完整名稱：${paymentNames.join('、')}。對不上或沒提到就省略。`
      : '- account 不確定就省略。',
    tradeAccounts.length > 0 ? `- 股票成交的 account（交割帳戶）可填：${tradeAccounts.join('、')}；不確定就省略。` : '',
    '- 同一筆資料若有券商 / 發票的單號，放進 "id" 以便去重。',
    '- 看不懂的內容略過，不要編造金額。',
    '',
    '接下來是要轉換的內容：',
  ].filter((line) => line !== '').join('\n');
}
