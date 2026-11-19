export const SEED_TW_STOCKS = [
  '0050', '2646', '2330', '2881', '2884', '2887', '2892', '2897', '4904', '6757', '8215',
] as const;

export const SEED_US_STOCKS = [
  'DIS', 'GOOGL', 'JPM', 'MA', 'META', 'MRVL', 'NVDA', 'TSLA', 'TSM',
] as const;

export const SEED_FX_PAIRS = [
  { base: 'USD', quote: 'TWD' },
  { base: 'JPY', quote: 'TWD' },
  { base: 'EUR', quote: 'TWD' },
  { base: 'IDR', quote: 'TWD' },
] as const;

export interface SeedCategory {
  key: string;
  name: string;
  type: 'expense' | 'income';
  icon: string;
  color: string;
  order: number;
}

export const DEFAULT_CATEGORIES: SeedCategory[] = [
  { key: 'food', name: '餐飲', type: 'expense', icon: 'Utensils', color: '#F59E0B', order: 1 },
  { key: 'transport', name: '交通', type: 'expense', icon: 'Car', color: '#3B82F6', order: 2 },
  { key: 'home', name: '居家', type: 'expense', icon: 'Home', color: '#10B981', order: 3 },
  { key: 'shopping', name: '購物', type: 'expense', icon: 'ShoppingBag', color: '#EC4899', order: 4 },
  { key: 'medical', name: '醫療', type: 'expense', icon: 'Stethoscope', color: '#EF4444', order: 5 },
  { key: 'entertainment', name: '娛樂', type: 'expense', icon: 'Gamepad2', color: '#8B5CF6', order: 6 },
  { key: 'education', name: '學習', type: 'expense', icon: 'BookOpen', color: '#06B6D4', order: 7 },
  { key: 'investment', name: '投資', type: 'expense', icon: 'TrendingUp', color: '#059669', order: 8 },
  { key: 'gift', name: '禮物', type: 'expense', icon: 'Gift', color: '#F97316', order: 9 },
  { key: 'other', name: '其他', type: 'expense', icon: 'MoreHorizontal', color: '#6B7280', order: 10 },
  { key: 'rental_purchase', name: '租賃資產購入', type: 'expense', icon: 'Building2', color: '#0F766E', order: 16 },
  { key: 'salary', name: '薪資', type: 'income', icon: 'Briefcase', color: '#0EA5E9', order: 11 },
  { key: 'bonus', name: '獎金', type: 'income', icon: 'Award', color: '#EAB308', order: 12 },
  { key: 'invest_return', name: '投資收益', type: 'income', icon: 'LineChart', color: '#10B981', order: 13 },
  { key: 'gift_income', name: '禮金', type: 'income', icon: 'Gift', color: '#F97316', order: 14 },
  { key: 'other_income', name: '其他', type: 'income', icon: 'MoreHorizontal', color: '#6B7280', order: 15 },
  { key: 'rental_income', name: '租賃收入', type: 'income', icon: 'Building2', color: '#0F766E', order: 17 },
  // 對帳調整：帳戶實際餘額與帳面不符時自動建立；不算日常消費（forecast / 異常偵測會排除）
  { key: 'adjustment', name: '對帳調整', type: 'expense', icon: 'Scale', color: '#94A3B8', order: 18 },
  { key: 'adjustment_income', name: '對帳調整', type: 'income', icon: 'Scale', color: '#94A3B8', order: 19 },
  // 共同帳本結算：付給 / 收到伴侶的結算款；不算日常消費（forecast / 異常偵測會排除）
  { key: 'household_settlement', name: '共同帳結算', type: 'expense', icon: 'HandCoins', color: '#F472B6', order: 20 },
  { key: 'household_settlement_income', name: '共同帳結算', type: 'income', icon: 'HandCoins', color: '#F472B6', order: 21 },
  // 保費（2026-11 F9）。Migration：既有使用者不需手動補 —— 帳戶頁第一次按「已繳保費」時
  // features/accounts/insurance-pay.ts 會在類別不存在時自動 upsert。也可以到「設定 → 資料」重跑類別 seed，
  // 但那會用預設名稱 / 圖示 merge 回所有預設類別（自訂過名稱的會被蓋回），只缺這一個時建議走自動補。
  { key: 'insurance', name: '保險', type: 'expense', icon: 'ShieldCheck', color: '#6366F1', order: 22 },
];

export const TRIP_CATEGORIES: SeedCategory[] = [
  { key: 'trip_ticket', name: '門票', type: 'expense', icon: 'Ticket', color: '#8B5CF6', order: 100 },
  { key: 'trip_hotel', name: '住宿', type: 'expense', icon: 'Hotel', color: '#0EA5E9', order: 101 },
  { key: 'trip_flight', name: '機票', type: 'expense', icon: 'Plane', color: '#3B82F6', order: 102 },
  { key: 'trip_local_transport', name: '當地交通', type: 'expense', icon: 'Bus', color: '#10B981', order: 103 },
  { key: 'trip_souvenir', name: '伴手禮', type: 'expense', icon: 'Gift', color: '#F97316', order: 104 },
  { key: 'trip_food', name: '旅遊餐飲', type: 'expense', icon: 'Utensils', color: '#F59E0B', order: 105 },
];

export const DEFAULT_PAYMENT_METHODS = [
  '現金', '信用卡-CUBE', '信用卡-JCB', '銀行轉帳', 'LINE Pay', '街口', '悠遊卡', '其他',
];
