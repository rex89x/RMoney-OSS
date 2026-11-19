/**
 * 系統內建行程模板 — `isSystem: true`，前端不可刪改。
 * 資料結構：一個模板含固定天數；每天有 N 個 time slot（建議時間 + 描述 + 類型）。
 * 使用時會根據使用者選的「出發日期」動態把天數映射成實際日期。
 */

import type { Currency } from '@/types/global';

export type ItineraryItemKind = 'transport' | 'food' | 'attraction' | 'accommodation' | 'shopping' | 'other';

export interface TemplateItem {
  time?: string;   // "09:00"
  title: string;
  kind: ItineraryItemKind;
  note?: string;
  estimatedCostTWD?: number;
  /** 給 geocode 用的搜尋字串（會帶目的地）；省略則 fallback 用 title */
  placeName?: string;
}

export interface TemplateDay {
  dayIndex: number;        // 1-based
  title?: string;          // e.g. "Day 1 — 抵達東京"
  items: TemplateItem[];
}

export interface TripTemplate {
  id: string;
  name: string;
  destinations: string[];
  days: number;
  baseCurrency: Currency;
  foreignCurrencies: Currency[];
  estimatedBudgetTWD: number;
  description: string;
  tags: string[];
  isSystem: boolean;
  dayPlan: TemplateDay[];
}

/* -------- 8 個系統模板 -------- */

export const SYSTEM_TEMPLATES: TripTemplate[] = [
  {
    id: 'sys-jp-tokyo-5d',
    name: '日本東京 5 天 4 夜',
    destinations: ['東京', '淺草', '新宿', '涉谷'],
    days: 5,
    baseCurrency: 'TWD',
    foreignCurrencies: ['JPY'],
    estimatedBudgetTWD: 45000,
    description: '適合第一次去東京的經典路線：淺草雷門 → 新宿購物 → 涉谷 → 築地 → 迪士尼。',
    tags: ['首都', '購物', '美食', '都會'],
    isSystem: true,
    dayPlan: [
      {
        dayIndex: 1,
        title: 'Day 1 — 抵達東京',
        items: [
          { time: '14:00', title: '桃園機場 → 成田機場', kind: 'transport', estimatedCostTWD: 12000 },
          { time: '18:30', title: 'N\'EX 特快進城', kind: 'transport', estimatedCostTWD: 800 },
          { time: '19:30', title: '飯店 check-in (新宿)', kind: 'accommodation' },
          { time: '20:30', title: '新宿歌舞伎町散策 + 晚餐', kind: 'food', estimatedCostTWD: 800 },
        ],
      },
      {
        dayIndex: 2,
        title: 'Day 2 — 淺草・上野・秋葉原',
        items: [
          { time: '09:00', title: '淺草雷門、仲見世通', kind: 'attraction' },
          { time: '11:30', title: '晴空塔（登塔與觀景）', kind: 'attraction', estimatedCostTWD: 700 },
          { time: '13:00', title: '午餐 — 淺草鰻魚飯', kind: 'food', estimatedCostTWD: 600 },
          { time: '15:00', title: '上野公園、阿美橫丁', kind: 'attraction' },
          { time: '18:00', title: '秋葉原電器、動漫採買', kind: 'shopping' },
        ],
      },
      {
        dayIndex: 3,
        title: 'Day 3 — 涉谷・原宿・表参道',
        items: [
          { time: '10:00', title: '明治神宮', kind: 'attraction' },
          { time: '11:30', title: '原宿・竹下通', kind: 'shopping' },
          { time: '13:30', title: '表参道午餐', kind: 'food', estimatedCostTWD: 800 },
          { time: '15:00', title: '涉谷 Scramble、Shibuya Sky', kind: 'attraction', estimatedCostTWD: 500 },
          { time: '19:00', title: '涉谷晚餐 — 居酒屋體驗', kind: 'food', estimatedCostTWD: 1500 },
        ],
      },
      {
        dayIndex: 4,
        title: 'Day 4 — 迪士尼或築地・銀座',
        items: [
          { time: '09:00', title: '東京迪士尼樂園（擇一）', kind: 'attraction', estimatedCostTWD: 2500 },
          { time: '09:00', title: '或 築地場外市場早餐', kind: 'food', estimatedCostTWD: 700 },
          { time: '14:00', title: '銀座逛街', kind: 'shopping' },
          { time: '19:00', title: '歸還行李、最後採買', kind: 'shopping' },
        ],
      },
      {
        dayIndex: 5,
        title: 'Day 5 — 返程',
        items: [
          { time: '09:00', title: '飯店退房', kind: 'accommodation' },
          { time: '10:00', title: 'N\'EX 返成田機場', kind: 'transport', estimatedCostTWD: 800 },
          { time: '13:00', title: '登機、返台', kind: 'transport' },
        ],
      },
    ],
  },
  {
    id: 'sys-jp-ksk-5d',
    name: '日本關西（大阪・京都）5 天',
    destinations: ['大阪', '京都', '奈良'],
    days: 5,
    baseCurrency: 'TWD',
    foreignCurrencies: ['JPY'],
    estimatedBudgetTWD: 42000,
    description: '大阪美食 + 京都古都 + 奈良鹿，經典關西三城。',
    tags: ['古都', '美食', '文化'],
    isSystem: true,
    dayPlan: [
      { dayIndex: 1, title: 'Day 1 — 抵達大阪', items: [
        { time: '14:00', title: '桃園 → 關西機場', kind: 'transport', estimatedCostTWD: 10000 },
        { time: '18:00', title: '南海電鐵 → 難波', kind: 'transport', estimatedCostTWD: 400 },
        { time: '19:30', title: '道頓堀晚餐（章魚燒、大阪燒）', kind: 'food', estimatedCostTWD: 1000 },
      ]},
      { dayIndex: 2, title: 'Day 2 — 大阪市區', items: [
        { time: '09:00', title: '大阪城', kind: 'attraction', estimatedCostTWD: 200 },
        { time: '11:30', title: '黑門市場吃到飽', kind: 'food', estimatedCostTWD: 1200 },
        { time: '14:00', title: '梅田 / 阪急百貨', kind: 'shopping' },
        { time: '17:00', title: '空中庭園展望台', kind: 'attraction', estimatedCostTWD: 500 },
        { time: '19:30', title: '心齋橋採買 + 晚餐', kind: 'food', estimatedCostTWD: 1500 },
      ]},
      { dayIndex: 3, title: 'Day 3 — 京都東山', items: [
        { time: '08:30', title: '大阪 → 京都 (JR)', kind: 'transport', estimatedCostTWD: 200 },
        { time: '10:00', title: '清水寺、二年坂、三年坂', kind: 'attraction', estimatedCostTWD: 200 },
        { time: '13:00', title: '傳統京料理午餐', kind: 'food', estimatedCostTWD: 1500 },
        { time: '15:00', title: '祇園、花見小路', kind: 'attraction' },
        { time: '17:00', title: '八坂神社、圓山公園', kind: 'attraction' },
      ]},
      { dayIndex: 4, title: 'Day 4 — 京都西北 + 奈良', items: [
        { time: '08:00', title: '金閣寺', kind: 'attraction', estimatedCostTWD: 200 },
        { time: '10:00', title: '嵐山、竹林小徑、渡月橋', kind: 'attraction' },
        { time: '13:00', title: '嵐山午餐', kind: 'food', estimatedCostTWD: 800 },
        { time: '15:00', title: '移動至奈良 (JR)', kind: 'transport', estimatedCostTWD: 300 },
        { time: '16:30', title: '奈良公園、東大寺、餵鹿', kind: 'attraction', estimatedCostTWD: 200 },
      ]},
      { dayIndex: 5, title: 'Day 5 — 返程', items: [
        { time: '10:00', title: '關西機場', kind: 'transport', estimatedCostTWD: 400 },
        { time: '13:00', title: '登機返台', kind: 'transport' },
      ]},
    ],
  },
  {
    id: 'sys-kr-seoul-4d',
    name: '韓國首爾 4 天 3 夜',
    destinations: ['首爾', '明洞', '弘大', '北村'],
    days: 4,
    baseCurrency: 'TWD',
    foreignCurrencies: ['KRW'],
    estimatedBudgetTWD: 28000,
    description: '明洞購物、北村韓服、弘大夜生活，短天數高密度。',
    tags: ['購物', '美食', '文化'],
    isSystem: true,
    dayPlan: [
      { dayIndex: 1, title: 'Day 1 — 抵達', items: [
        { time: '13:00', title: '桃園 → 仁川機場', kind: 'transport', estimatedCostTWD: 8000 },
        { time: '17:00', title: '機場快線 → 首爾站', kind: 'transport', estimatedCostTWD: 300 },
        { time: '19:00', title: '明洞晚餐 + 採買', kind: 'food', estimatedCostTWD: 700 },
      ]},
      { dayIndex: 2, title: 'Day 2 — 古宮與北村', items: [
        { time: '09:00', title: '景福宮（租韓服）', kind: 'attraction', estimatedCostTWD: 500 },
        { time: '12:00', title: '北村韓屋村', kind: 'attraction' },
        { time: '14:00', title: '仁寺洞傳統街午餐', kind: 'food', estimatedCostTWD: 800 },
        { time: '17:00', title: '廣藏市場小吃', kind: 'food', estimatedCostTWD: 500 },
        { time: '20:00', title: '東大門逛到半夜', kind: 'shopping' },
      ]},
      { dayIndex: 3, title: 'Day 3 — 弘大 + 梨泰院', items: [
        { time: '10:00', title: '弘大商圈', kind: 'shopping' },
        { time: '13:00', title: '弘大烤肉午餐', kind: 'food', estimatedCostTWD: 1000 },
        { time: '15:00', title: '梨泰院 Itaewon', kind: 'attraction' },
        { time: '18:00', title: '南山塔（夜景）', kind: 'attraction', estimatedCostTWD: 500 },
        { time: '21:00', title: '炸雞啤酒收尾', kind: 'food', estimatedCostTWD: 700 },
      ]},
      { dayIndex: 4, title: 'Day 4 — 返程', items: [
        { time: '09:00', title: '飯店退房', kind: 'accommodation' },
        { time: '11:00', title: '機場快線', kind: 'transport', estimatedCostTWD: 300 },
        { time: '13:30', title: '登機返台', kind: 'transport' },
      ]},
    ],
  },
  {
    id: 'sys-th-bkk-cnx-7d',
    name: '泰國曼谷清邁 7 天',
    destinations: ['曼谷', '清邁'],
    days: 7,
    baseCurrency: 'TWD',
    foreignCurrencies: ['THB'],
    estimatedBudgetTWD: 38000,
    description: '曼谷水上市場 + 清邁夜市 + 寺廟體驗，南北雙城。',
    tags: ['寺廟', '按摩', '夜市'],
    isSystem: true,
    dayPlan: [
      { dayIndex: 1, title: 'Day 1 — 抵達曼谷', items: [
        { time: '12:00', title: '桃園 → 素萬那普機場', kind: 'transport', estimatedCostTWD: 9000 },
        { time: '16:00', title: 'Sukhumvit 飯店 check-in', kind: 'accommodation' },
        { time: '19:00', title: 'Asiatique 河畔夜市晚餐', kind: 'food', estimatedCostTWD: 500 },
      ]},
      { dayIndex: 2, title: 'Day 2 — 大皇宮 + 臥佛寺', items: [
        { time: '09:00', title: '大皇宮、玉佛寺', kind: 'attraction', estimatedCostTWD: 500 },
        { time: '12:30', title: '河畔午餐', kind: 'food', estimatedCostTWD: 400 },
        { time: '14:00', title: '臥佛寺', kind: 'attraction', estimatedCostTWD: 100 },
        { time: '16:00', title: 'Spa 按摩 2hr', kind: 'other', estimatedCostTWD: 800 },
        { time: '19:00', title: 'Rooftop Bar 晚餐', kind: 'food', estimatedCostTWD: 1500 },
      ]},
      { dayIndex: 3, title: 'Day 3 — 水上市場 + 夜市', items: [
        { time: '08:00', title: 'Damnoen Saduak 水上市場', kind: 'attraction', estimatedCostTWD: 1000 },
        { time: '13:00', title: '美功鐵道市場', kind: 'attraction' },
        { time: '18:00', title: 'Chatuchak 週末市集', kind: 'shopping' },
      ]},
      { dayIndex: 4, title: 'Day 4 — 飛清邁', items: [
        { time: '10:00', title: '曼谷 → 清邁 (國內線)', kind: 'transport', estimatedCostTWD: 2500 },
        { time: '14:00', title: '古城四方寺廟巡禮', kind: 'attraction', estimatedCostTWD: 300 },
        { time: '18:00', title: '週日夜市（如逢週日）', kind: 'shopping' },
        { time: '20:00', title: '康泰魚火鍋晚餐', kind: 'food', estimatedCostTWD: 400 },
      ]},
      { dayIndex: 5, title: 'Day 5 — 素帖山 + 大象', items: [
        { time: '08:30', title: '大象自然公園（半日）', kind: 'attraction', estimatedCostTWD: 2800 },
        { time: '15:00', title: '素帖山雙龍寺', kind: 'attraction', estimatedCostTWD: 200 },
        { time: '19:00', title: 'Nimman 區晚餐', kind: 'food', estimatedCostTWD: 600 },
      ]},
      { dayIndex: 6, title: 'Day 6 — 泰拳 + 回曼谷', items: [
        { time: '10:00', title: '泰式料理教室', kind: 'other', estimatedCostTWD: 1200 },
        { time: '15:00', title: '清邁 → 曼谷', kind: 'transport', estimatedCostTWD: 2500 },
        { time: '20:00', title: '泰拳表演', kind: 'attraction', estimatedCostTWD: 1500 },
      ]},
      { dayIndex: 7, title: 'Day 7 — 返程', items: [
        { time: '09:00', title: '退房最後採買', kind: 'shopping' },
        { time: '13:00', title: '登機返台', kind: 'transport' },
      ]},
    ],
  },
  {
    id: 'sys-tw-round-7d',
    name: '台灣環島 7 天自駕',
    destinations: ['台北', '花蓮', '台東', '高雄', '台中'],
    days: 7,
    baseCurrency: 'TWD',
    foreignCurrencies: [],
    estimatedBudgetTWD: 30000,
    description: '逆時針環島：北 → 東 → 南 → 中 → 北，經典自駕路線。',
    tags: ['自駕', '東部', '南部'],
    isSystem: true,
    dayPlan: [
      { dayIndex: 1, title: 'Day 1 — 台北 → 宜蘭 → 花蓮', items: [
        { time: '08:00', title: '台北出發，走雪山隧道', kind: 'transport' },
        { time: '11:00', title: '宜蘭羅東夜市準備（午餐）', kind: 'food', estimatedCostTWD: 300 },
        { time: '14:00', title: '蘇花改 → 清水斷崖', kind: 'attraction' },
        { time: '17:00', title: '花蓮市區飯店', kind: 'accommodation', estimatedCostTWD: 2500 },
      ]},
      { dayIndex: 2, title: 'Day 2 — 太魯閣', items: [
        { time: '08:30', title: '太魯閣國家公園', kind: 'attraction' },
        { time: '13:00', title: '天祥山下午餐', kind: 'food', estimatedCostTWD: 400 },
        { time: '16:00', title: '七星潭夕陽', kind: 'attraction' },
      ]},
      { dayIndex: 3, title: 'Day 3 — 花蓮 → 台東', items: [
        { time: '09:00', title: '台 11 沿海公路', kind: 'transport' },
        { time: '11:00', title: '石梯坪', kind: 'attraction' },
        { time: '13:00', title: '成功漁港午餐', kind: 'food', estimatedCostTWD: 500 },
        { time: '16:00', title: '三仙台', kind: 'attraction' },
        { time: '18:30', title: '台東池上便當晚餐', kind: 'food', estimatedCostTWD: 200 },
      ]},
      { dayIndex: 4, title: 'Day 4 — 台東 → 墾丁 → 高雄', items: [
        { time: '08:00', title: '南迴公路', kind: 'transport' },
        { time: '11:00', title: '墾丁南灣', kind: 'attraction' },
        { time: '14:00', title: '龍磐公園、貓鼻頭', kind: 'attraction' },
        { time: '18:00', title: '高雄入住 + 瑞豐夜市', kind: 'food', estimatedCostTWD: 500 },
      ]},
      { dayIndex: 5, title: 'Day 5 — 高雄 → 台南 → 台中', items: [
        { time: '09:00', title: '駁二特區', kind: 'attraction' },
        { time: '12:00', title: '台南小吃巡禮（牛肉湯、擔仔麵）', kind: 'food', estimatedCostTWD: 500 },
        { time: '15:00', title: '安平古堡、奇美博物館', kind: 'attraction', estimatedCostTWD: 200 },
        { time: '19:00', title: '台中逢甲夜市', kind: 'food', estimatedCostTWD: 400 },
      ]},
      { dayIndex: 6, title: 'Day 6 — 台中 → 苗栗 → 新竹', items: [
        { time: '09:00', title: '高美濕地', kind: 'attraction' },
        { time: '12:00', title: '苗栗南庄客家菜', kind: 'food', estimatedCostTWD: 500 },
        { time: '15:00', title: '新竹內灣老街', kind: 'attraction' },
      ]},
      { dayIndex: 7, title: 'Day 7 — 返台北', items: [
        { time: '10:00', title: '新竹 → 台北', kind: 'transport' },
        { time: '13:00', title: '返家', kind: 'other' },
      ]},
    ],
  },
  {
    id: 'sys-okinawa-4d',
    name: '日本沖繩自駕 4 天',
    destinations: ['沖繩', '那霸', '美麗海水族館'],
    days: 4,
    baseCurrency: 'TWD',
    foreignCurrencies: ['JPY'],
    estimatedBudgetTWD: 32000,
    description: '自駕環島、美麗海水族館、國際通採買，家庭友善。',
    tags: ['自駕', '海島', '親子'],
    isSystem: true,
    dayPlan: [
      { dayIndex: 1, title: 'Day 1 — 抵達那霸', items: [
        { time: '13:00', title: '桃園 → 那霸機場', kind: 'transport', estimatedCostTWD: 8000 },
        { time: '17:00', title: '取車、飯店 check-in', kind: 'transport', estimatedCostTWD: 3000 },
        { time: '19:00', title: '國際通晚餐 + 採買', kind: 'food', estimatedCostTWD: 1000 },
      ]},
      { dayIndex: 2, title: 'Day 2 — 美麗海水族館', items: [
        { time: '08:30', title: '北上，美麗海水族館', kind: 'attraction', estimatedCostTWD: 600 },
        { time: '13:00', title: '本部町午餐', kind: 'food', estimatedCostTWD: 800 },
        { time: '15:00', title: '古宇利大橋、古宇利島', kind: 'attraction' },
        { time: '19:00', title: '名護晚餐', kind: 'food', estimatedCostTWD: 1000 },
      ]},
      { dayIndex: 3, title: 'Day 3 — 南部海岸', items: [
        { time: '09:00', title: '萬座毛', kind: 'attraction' },
        { time: '11:00', title: '殘波岬燈塔', kind: 'attraction' },
        { time: '13:00', title: '海鮮午餐', kind: 'food', estimatedCostTWD: 1000 },
        { time: '15:00', title: '首里城遺跡', kind: 'attraction', estimatedCostTWD: 300 },
        { time: '19:00', title: '首里泡盛居酒屋', kind: 'food', estimatedCostTWD: 1500 },
      ]},
      { dayIndex: 4, title: 'Day 4 — 返程', items: [
        { time: '09:00', title: '還車、機場', kind: 'transport' },
        { time: '12:30', title: '登機返台', kind: 'transport' },
      ]},
    ],
  },
  {
    id: 'sys-vn-hcm-da-6d',
    name: '越南胡志明・峴港 6 天',
    destinations: ['胡志明', '峴港', '會安'],
    days: 6,
    baseCurrency: 'TWD',
    foreignCurrencies: ['VND'],
    estimatedBudgetTWD: 26000,
    description: '南北越景點融合：胡志明現代都會 + 峴港海岸 + 會安古城。',
    tags: ['海岸', '古城', '法式殖民'],
    isSystem: true,
    dayPlan: [
      { dayIndex: 1, title: 'Day 1 — 抵達胡志明', items: [
        { time: '11:00', title: '桃園 → 胡志明', kind: 'transport', estimatedCostTWD: 8000 },
        { time: '16:00', title: '飯店 check-in + 市場採買', kind: 'shopping' },
        { time: '19:00', title: '越式火鍋晚餐', kind: 'food', estimatedCostTWD: 600 },
      ]},
      { dayIndex: 2, title: 'Day 2 — 胡志明市區', items: [
        { time: '09:00', title: '紅教堂、中央郵局', kind: 'attraction' },
        { time: '11:00', title: '統一宮', kind: 'attraction', estimatedCostTWD: 150 },
        { time: '13:00', title: '法式麵包午餐', kind: 'food', estimatedCostTWD: 200 },
        { time: '15:00', title: 'Ben Thanh Market', kind: 'shopping' },
        { time: '19:00', title: 'Saigon River cruise 晚餐', kind: 'food', estimatedCostTWD: 1200 },
      ]},
      { dayIndex: 3, title: 'Day 3 — 飛峴港', items: [
        { time: '11:00', title: '胡志明 → 峴港', kind: 'transport', estimatedCostTWD: 2000 },
        { time: '15:00', title: '美溪沙灘 My Khe Beach', kind: 'attraction' },
        { time: '18:00', title: '峴港龍橋、河畔晚餐', kind: 'food', estimatedCostTWD: 600 },
      ]},
      { dayIndex: 4, title: 'Day 4 — 巴拿山', items: [
        { time: '08:30', title: '巴拿山 Ba Na Hills（金手橋）', kind: 'attraction', estimatedCostTWD: 1500 },
        { time: '18:00', title: '返回峴港', kind: 'transport' },
      ]},
      { dayIndex: 5, title: 'Day 5 — 會安古城', items: [
        { time: '10:00', title: '峴港 → 會安', kind: 'transport', estimatedCostTWD: 500 },
        { time: '12:00', title: '會安古城午餐', kind: 'food', estimatedCostTWD: 400 },
        { time: '15:00', title: '日本橋、古城街巡禮', kind: 'attraction' },
        { time: '20:00', title: '燈籠河畔晚餐', kind: 'food', estimatedCostTWD: 800 },
      ]},
      { dayIndex: 6, title: 'Day 6 — 返程', items: [
        { time: '09:00', title: '峴港機場', kind: 'transport' },
        { time: '12:00', title: '登機返台', kind: 'transport' },
      ]},
    ],
  },
  {
    id: 'sys-sg-3d',
    name: '新加坡 3 天 2 夜',
    destinations: ['新加坡', '聖淘沙', '濱海灣'],
    days: 3,
    baseCurrency: 'TWD',
    foreignCurrencies: ['SGD'],
    estimatedBudgetTWD: 26000,
    description: '高密度短假期：濱海灣、聖淘沙、小印度、牛車水。',
    tags: ['都會', '短天數', '親子'],
    isSystem: true,
    dayPlan: [
      { dayIndex: 1, title: 'Day 1 — 抵達', items: [
        { time: '10:00', title: '桃園 → 樟宜機場', kind: 'transport', estimatedCostTWD: 10000 },
        { time: '15:00', title: '飯店 check-in', kind: 'accommodation' },
        { time: '17:00', title: '牛車水逛街', kind: 'shopping' },
        { time: '19:00', title: '海南雞飯晚餐', kind: 'food', estimatedCostTWD: 400 },
      ]},
      { dayIndex: 2, title: 'Day 2 — 聖淘沙', items: [
        { time: '09:00', title: '聖淘沙環球影城', kind: 'attraction', estimatedCostTWD: 2000 },
        { time: '18:00', title: 'S.E.A. 海洋館', kind: 'attraction', estimatedCostTWD: 1000 },
        { time: '20:00', title: '聖淘沙晚餐 + 水舞秀', kind: 'food', estimatedCostTWD: 1000 },
      ]},
      { dayIndex: 3, title: 'Day 3 — 濱海灣 + 返程', items: [
        { time: '09:00', title: '濱海灣花園 Gardens by the Bay', kind: 'attraction', estimatedCostTWD: 500 },
        { time: '11:30', title: '金沙空中花園觀景', kind: 'attraction', estimatedCostTWD: 700 },
        { time: '13:00', title: 'Lau Pa Sat 午餐', kind: 'food', estimatedCostTWD: 400 },
        { time: '17:00', title: '登機返台', kind: 'transport' },
      ]},
    ],
  },
];

export function getTemplateById(id: string): TripTemplate | undefined {
  return SYSTEM_TEMPLATES.find((t) => t.id === id);
}
