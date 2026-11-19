import { CalendarCheck, ListChecks, PieChart, Plane, Repeat } from 'lucide-react';
import type { AnalysisDefinition, AnalysisKind } from './types';

export const ANALYSIS_DEFINITIONS: AnalysisDefinition[] = [
  {
    kind: 'monthlyReview',
    title: '月度財務回顧',
    description: '收支與儲蓄率、和前一個月比變化最大的類別、大額支出、預算執行，附下個月的具體建議。',
    dataScope: '該月與前一月的類別 / 逐月彙總、預算，以及它判斷需要追查的交易明細',
    icon: CalendarCheck,
    needsMonth: true,
  },
  {
    kind: 'subscriptionAudit',
    title: '固定支出 / 訂閱健檢',
    description: '找出每月固定成本、沒設成週期的疑似訂閱、漲價項目與可以取消的項目（附年化金額）。',
    dataScope: '週期範本、訂閱、近 3 個月依店家彙總的重複支出與相關明細',
    icon: Repeat,
    needsMonth: false,
  },
  {
    kind: 'portfolioReview',
    title: '投資組合健檢',
    description: '持股集中度、台美股配置、損益結構、投資占淨值比例與再平衡方向（不給個股買賣指示）。',
    dataScope: '最新持股明細、市值走勢、淨值快照、投資規劃',
    icon: PieChart,
    needsMonth: false,
  },
  {
    kind: 'transactionCleanup',
    title: '記帳品質檢查',
    description: '近 60 天交易裡疑似分類錯誤、重複記帳、備註太模糊或金額異常的項目，列成表格。',
    dataScope: '近 60 天的交易明細（日期、金額、類別、備註、支付方式）與類別清單',
    icon: ListChecks,
    needsMonth: false,
  },
  {
    kind: 'tripReview',
    title: '旅遊計畫檢視',
    description: '預算合不合理、每天行程會不會太趕、還缺哪些準備、出發前的財務面提醒，附調整建議。',
    dataScope: '旅程基本資料、行程表、旅程已記帳的花費，必要時查匯率與帳戶餘額',
    icon: Plane,
    needsMonth: false,
    needsTrip: true,
  },
];

export function analysisDefinition(kind: AnalysisKind): AnalysisDefinition {
  const found = ANALYSIS_DEFINITIONS.find((d) => d.kind === kind);
  if (!found) throw new Error(`unknown analysis kind: ${kind}`);
  return found;
}

/** 後端工具名稱（apps-script/src/HubTools.gs）→ 顯示名稱 */
const TOOL_LABELS: Record<string, string> = {
  hub_catalog: '資料目錄',
  sum_by_category: '類別彙總',
  sum_by_month: '逐月收支',
  sum_by_payment_method: '支付方式彙總',
  spend_by_merchant: '店家彙總',
  list_transactions: '交易明細',
  budget_status: '預算',
  accounts_balance: '帳戶餘額',
  net_worth_latest: '最新淨值',
  net_worth_history: '淨值走勢',
  portfolio_latest: '投資摘要',
  portfolio_positions: '持股明細',
  portfolio_history: '投資走勢',
  stock_quotes: '股票報價',
  list_trips: '旅程清單',
  trip_detail: '旅程資料',
  trip_itinerary: '行程表',
  trip_expenses: '旅程花費',
  flight_watches: '機票追蹤清單',
  flight_price_history: '機票價格走勢',
  flight_date_prices: '各出發日票價',
  list_records: '其他資料集',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}
