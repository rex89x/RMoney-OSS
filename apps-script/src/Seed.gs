/**
 * Seed data helper — run once to populate initial stocks/categories/fx pairs
 * Run `seedAll()` from the Apps Script editor after first setup.
 */

var SEED_TW = ['0050', '2646', '2330', '2881', '2884', '2887', '2892', '2897', '4904', '6757', '8215'];
var SEED_US = ['DIS', 'GOOGL', 'JPM', 'MA', 'META', 'MRVL', 'NVDA', 'TSLA', 'TSM'];

function seedAll() {
  seedStocks_();
  seedCategories_();
  return { ok: true };
}

function seedStocks_() {
  var now = new Date();
  SEED_TW.forEach(function (s) {
    fsSetDoc_('stocks/' + s, {
      symbol: s, market: 'TW', currency: 'TWD', name: s,
      currentPrice: 0, change: 0, changePercent: 0,
      volume: 0, high: 0, low: 0, open: 0, prevClose: 0,
      updatedAt: now,
    }, true);
  });
  SEED_US.forEach(function (s) {
    fsSetDoc_('stocks/' + s, {
      symbol: s, market: 'US', currency: 'USD', name: s,
      currentPrice: 0, change: 0, changePercent: 0,
      volume: 0, high: 0, low: 0, open: 0, prevClose: 0,
      updatedAt: now,
    }, true);
  });
}

var DEFAULT_CATEGORIES = [
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
  { key: 'salary', name: '薪資', type: 'income', icon: 'Briefcase', color: '#0EA5E9', order: 11 },
  { key: 'bonus', name: '獎金', type: 'income', icon: 'Award', color: '#EAB308', order: 12 },
  { key: 'invest_return', name: '投資收益', type: 'income', icon: 'LineChart', color: '#10B981', order: 13 },
  { key: 'gift_income', name: '禮金', type: 'income', icon: 'Gift', color: '#F97316', order: 14 },
  { key: 'other_income', name: '其他', type: 'income', icon: 'MoreHorizontal', color: '#6B7280', order: 15 },
  // 與 apps/web/src/lib/seed-data.ts 同步（2026-11 F9 保費）
  { key: 'insurance', name: '保險', type: 'expense', icon: 'ShieldCheck', color: '#6366F1', order: 22 },
];

function seedCategories_() {
  DEFAULT_CATEGORIES.forEach(function (c) {
    fsSetDoc_('categories/' + c.key, c, true);
  });
}
