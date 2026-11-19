export type Currency = 'TWD' | 'USD' | 'JPY' | 'EUR' | 'IDR' | string;

export type UserRole = 'admin' | 'owner' | 'member' | 'viewer' | 'guest';

export type ThemeMode = 'auto' | 'light' | 'dark';

export type NotificationKey =
  | 'ledgerDaily'
  | 'ledgerMonthly'
  | 'budgetWarn'
  | 'recurringRun'
  | 'tripDaily'
  | 'tripCountdown'
  | 'flightDeals'
  | 'aiBudget'
  | 'marketDaily'
  | 'fxDaily'
  | 'alertHit'
  | 'errors'
  | 'loansReminder'
  | 'loanDue'
  | 'insuranceDue'
  | 'creditCardDue'
  | 'monthlyForecast'
  | 'categoryAnomaly'
  | 'subscriptionsDigest'
  | 'fixedExpensesMonthly'
  | 'tripRecap'
  | 'scheduledPaymentDue'
  | 'savingsGoalProgress'
  | 'investmentPlanProgress'
  | 'financialHealthDigest'
  | 'swingSignals'
  | 'stockRadar'
  | 'taifex'
  | 'weeklyBackup'
  | 'payoutGroupReminder'
  | 'weeklyReview'
  | 'dividendCalendar'
  | 'taxSeason'
  | 'einvoiceSync';

export type NotificationPrefs = Partial<Record<NotificationKey, boolean>>;

export type DashboardCardKey =
  | 'kpi'
  | 'monthStatus'
  | 'fxRates'
  | 'topMovers'
  | 'portfolioSummary'
  | 'netWorth'
  | 'accountsOverview'
  | 'rentals'
  | 'dailyBudgetRemaining'
  | 'subscriptions'
  | 'scheduledPayments'
  | 'savingsGoals'
  | 'household'
  | 'emergencyFund'
  | 'monthlyForecast'
  | 'cashflowWaterfall'
  | 'tripRecap'
  | 'upcomingTrip'
  | 'flightRadar'
  | 'stockRadar'
  | 'sparkline'
  | 'categoryPie'
  | 'monthlyIncomeExpense'
  | 'dailyCumulative'
  | 'paymentMethod'
  | 'budgetRing'
  | 'stats'
  | 'settlement'
  | 'recentTransactions';

export interface FlightRadarPrefs {
  order?: string[];
  hiddenSections?: string[];
}

export type DashboardScope = 'thisMonth' | 'lastMonth' | 'thisQuarter' | 'ytd';

export type DashboardSectionKey = 'focus' | 'cashflow' | 'invest' | 'more';

export interface DashboardPrefs {
  scope?: DashboardScope;
  hiddenCards?: DashboardCardKey[];
  /** 卡片顯示順序，預設 = 所有 DashboardCardKey 的自然順序 */
  order?: DashboardCardKey[];
  /** 折疊的區段（預設只折疊 'more'） */
  collapsedSections?: DashboardSectionKey[];
}

/** 投資配置目標：依市場（TW/US）或全部現金/股 — 比例加總應為 100 */
export interface AllocationTarget {
  /** key 可以是 'TW' / 'US' / 'cash' / 自訂 'crypto' / 'bond' */
  key: string;
  label: string;
  pct: number;
  color?: string;
}

export interface EmergencyFundConfig {
  /** 目標月數（預設 6） */
  targetMonths: number;
  /** 月支出基準（預設用過去 3 個月平均） */
  monthlyBaseline?: number | null;
}

/** 投資賣出成本法：平均成本（台股慣例）/ FIFO 先進先出（美股報稅常用） */
export type CostBasisMethod = 'average' | 'fifo';

export interface UserDoc {
  id: string;
  email: string;
  displayName: string | null;
  photoURL: string | null;
  role: UserRole;
  /**
   * 允許讀取「我的個人支出」的 uid 清單（共同帳本成員）。
   * Firestore rules 以這個欄位放行 `transactions` 的 read（只放行 type == 'expense'）。
   * 只有本人（或 admin）寫得進來 — 分享的是自己的資料。
   */
  ledgerSharedWith: string[];
  /**
   * 允許「編輯」我的個人支出的 uid 清單（一定是 ledgerSharedWith 的子集合；由 setLedgerSharing 維護）。
   * rules 以這個欄位放行 `transactions` 的 update（僅 type == 'expense'、userId 不變），
   * 以及同一筆 runTransaction 裡對我 `accounts` 餘額欄位的回補。
   */
  ledgerEditors: string[];
  preferences: {
    theme?: ThemeMode;
    mainCurrency?: Currency;
    notifications?: NotificationPrefs;
    dashboard?: DashboardPrefs;
    allocationTargets?: AllocationTarget[];
    emergencyFund?: EmergencyFundConfig;
    /** 過去 N 年同月份 trip 回顧的預設範圍 */
    tripRecapYears?: number;
    /** 機票雷達總覽的區塊順序與隱藏設定 */
    flightRadar?: FlightRadarPrefs;
    /** 投資賣出成本計算方式（預設 average；見 features/investments/cost-basis.ts） */
    costBasisMethod?: CostBasisMethod;
  };
  createdAt: Date | null;
}

export interface AllowedEmailsDoc {
  emails: string[];
}
