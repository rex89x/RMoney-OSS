/**
 * 行李清單範本產生器（純函式，測試：apps/web/tests/trips-packing.test.cjs）。
 *
 * 依「天數 × 國內外 × 季節 / 目的地氣候」產生一份起始清單，使用者再自行增刪。
 * 季節用出發日的台北日曆月份判斷（CLAUDE.md §11）；目的地氣候只認得常見地名，
 * 認不得就只看季節（假設北半球）。
 */
import { daysBetweenTWDates, formatTWDateInput } from '@/lib/tz';
import type { PackingCategory } from './types';

export type PackingClimate = 'tropical' | 'temperate' | 'cold';
export type PackingHemisphere = 'north' | 'south';
export type PackingSeason = 'spring' | 'summer' | 'autumn' | 'winter';
/** 實際用來挑衣物的體感：熱 / 溫和 / 冷 */
export type PackingWeather = 'hot' | 'mild' | 'cold';

export interface PackingTemplateInput {
  /** 旅程天數（含頭尾），至少 1 */
  days: number;
  /** 出發月份 1–12（台北時間） */
  startMonth: number;
  international: boolean;
  /** 目的地氣候；null = 認不得，只看季節 */
  climate: PackingClimate | null;
  hemisphere: PackingHemisphere;
}

export interface PackingTemplateItem {
  name: string;
  category: PackingCategory;
  quantity: number;
}

// ---- 地名判斷 ----

const TAIWAN_KEYWORDS = [
  '台灣', '臺灣', '台北', '臺北', '新北', '基隆', '桃園', '新竹', '苗栗', '台中', '臺中', '彰化', '南投',
  '雲林', '嘉義', '台南', '臺南', '高雄', '屏東', '墾丁', '宜蘭', '花蓮', '台東', '臺東', '澎湖', '金門',
  '馬祖', '綠島', '蘭嶼', '小琉球', '阿里山', '日月潭', '九份', '淡水',
  'taiwan', 'taipei', 'taichung', 'tainan', 'kaohsiung', 'hualien', 'yilan', 'kenting',
];

const TROPICAL_KEYWORDS = [
  '泰國', '曼谷', '清邁', '普吉', '芭達雅', '蘇美', '峇里', '巴厘', '印尼', '雅加達', '新加坡', '馬來西亞',
  '吉隆坡', '檳城', '沙巴', '亞庇', '蘭卡威', '越南', '胡志明', '峴港', '芽莊', '富國', '菲律賓', '馬尼拉',
  '宿霧', '長灘', '薄荷', '巴拉望', '關島', '塞班', '帛琉', '馬爾地夫', '夏威夷', '柬埔寨', '吳哥', '斯里蘭卡',
  'thailand', 'bangkok', 'phuket', 'bali', 'singapore', 'malaysia', 'vietnam', 'philippines', 'cebu',
  'guam', 'saipan', 'palau', 'maldives', 'hawaii',
];

const COLD_KEYWORDS = [
  '冰島', '芬蘭', '羅瓦涅米', '挪威', '特羅姆瑟', '阿拉斯加', '格陵蘭', '南極', '北極', '黃刀',
  'iceland', 'finland', 'norway', 'alaska', 'yellowknife', 'antarctica',
];

const SOUTH_HEMISPHERE_KEYWORDS = [
  '澳洲', '澳大利亞', '雪梨', '墨爾本', '布里斯本', '黃金海岸', '伯斯', '凱恩斯', '紐西蘭', '奧克蘭',
  '皇后鎮', '基督城', '南非', '開普敦', '阿根廷', '智利', '祕魯', '秘魯', '巴西', '南極',
  'australia', 'sydney', 'melbourne', 'new zealand', 'auckland', 'queenstown', 'south africa',
  'argentina', 'chile', 'peru', 'brazil', 'antarctica',
];

function matches(destination: string, keywords: string[]): boolean {
  const s = destination.trim().toLowerCase();
  if (!s) return false;
  return keywords.some((k) => s.includes(k));
}

export function isTaiwanPlace(destination: string): boolean {
  return matches(destination, TAIWAN_KEYWORDS);
}

/** 目的地有任何一個不是台灣地名，或有外幣 → 國外 */
export function isInternationalTrip(destinations: string[], foreignCurrencies: string[] = []): boolean {
  if (foreignCurrencies.some((c) => c && c !== 'TWD')) return true;
  const named = destinations.map((d) => d.trim()).filter(Boolean);
  if (named.length === 0) return false;
  return named.some((d) => !isTaiwanPlace(d));
}

/** 認得的地名才回氣候；多個目的地取最「極端」的（冷 > 熱 > 溫帶），讓清單寧可多帶 */
export function inferClimate(destinations: string[]): PackingClimate | null {
  const named = destinations.map((d) => d.trim()).filter(Boolean);
  if (named.length === 0) return null;
  if (named.some((d) => matches(d, COLD_KEYWORDS))) return 'cold';
  if (named.some((d) => matches(d, TROPICAL_KEYWORDS))) return 'tropical';
  // 台灣、日韓、歐美等常見目的地都算四季分明（台灣冬天也要外套）
  return 'temperate';
}

export function inferHemisphere(destinations: string[]): PackingHemisphere {
  return destinations.some((d) => matches(d, SOUTH_HEMISPHERE_KEYWORDS)) ? 'south' : 'north';
}

export function seasonForMonth(month: number, hemisphere: PackingHemisphere = 'north'): PackingSeason {
  const m = ((Math.round(month) - 1) % 12 + 12) % 12 + 1;
  const shifted = hemisphere === 'south' ? ((m + 5) % 12) + 1 : m;
  if (shifted >= 3 && shifted <= 5) return 'spring';
  if (shifted >= 6 && shifted <= 8) return 'summer';
  if (shifted >= 9 && shifted <= 11) return 'autumn';
  return 'winter';
}

export function resolveWeather(input: Pick<PackingTemplateInput, 'startMonth' | 'climate' | 'hemisphere'>): PackingWeather {
  if (input.climate === 'tropical') return 'hot';
  if (input.climate === 'cold') return 'cold';
  const season = seasonForMonth(input.startMonth, input.hemisphere);
  if (season === 'summer') return 'hot';
  if (season === 'winter') return 'cold';
  return 'mild';
}

export interface PackingTripLike {
  destination: string[];
  startDate: Date;
  endDate: Date;
  foreignCurrencies?: string[];
}

/** 從旅程推出範本參數；天數 / 月份一律用台北日曆日 */
export function inferPackingContext(trip: PackingTripLike): PackingTemplateInput {
  const days = Math.max(1, daysBetweenTWDates(trip.startDate, trip.endDate) + 1);
  const startMonth = Number(formatTWDateInput(trip.startDate).slice(5, 7)) || 1;
  return {
    days,
    startMonth,
    international: isInternationalTrip(trip.destination, trip.foreignCurrencies ?? []),
    climate: inferClimate(trip.destination),
    hemisphere: inferHemisphere(trip.destination),
  };
}

// ---- 範本 ----

/** 換洗衣物最多帶一週份，再長就洗衣服 */
const MAX_CLOTHES_DAYS = 7;

export function buildPackingTemplate(input: PackingTemplateInput): PackingTemplateItem[] {
  const days = Math.max(1, Math.round(input.days) || 1);
  const clothesDays = Math.min(days, MAX_CLOTHES_DAYS);
  const weather = resolveWeather(input);
  const out: PackingTemplateItem[] = [];
  const add = (category: PackingCategory, name: string, quantity = 1) => {
    out.push({ category, name, quantity: Math.max(1, quantity) });
  };

  // 證件 / 金錢
  if (input.international) {
    add('documents', '護照（效期 6 個月以上）');
    add('documents', '機票 / 登機證');
    add('documents', '簽證 / 入境資料');
    add('documents', '旅平險 / 不便險文件');
    add('documents', '外幣');
  } else {
    add('documents', '身分證 / 健保卡');
  }
  add('documents', '信用卡 / 金融卡');
  add('documents', '台幣現金');
  add('documents', '訂房 / 交通確認單');

  // 衣物
  add('clothes', weather === 'hot' ? '短袖上衣' : '上衣', clothesDays);
  add('clothes', weather === 'hot' ? '短褲 / 裙子' : '長褲 / 裙子', Math.ceil(clothesDays / 2));
  add('clothes', '內衣褲', Math.min(days + 1, MAX_CLOTHES_DAYS + 1));
  add('clothes', '襪子', Math.min(days + 1, MAX_CLOTHES_DAYS + 1));
  add('clothes', '睡衣');
  add('clothes', '好走的鞋');
  if (weather === 'mild') add('clothes', '薄外套');
  if (weather === 'cold') {
    add('clothes', '保暖外套 / 羽絨衣');
    add('clothes', '發熱衣', Math.min(Math.ceil(days / 2), 4));
    add('clothes', '毛帽');
    add('clothes', '手套');
    add('clothes', '圍巾');
  }
  if (weather === 'hot') {
    add('clothes', '帽子');
    add('clothes', '太陽眼鏡');
    add('clothes', '拖鞋 / 涼鞋');
  }
  if (input.climate === 'tropical') add('clothes', '泳衣');

  // 盥洗 / 保養
  add('toiletries', '牙刷 / 牙膏');
  add('toiletries', '洗面乳');
  add('toiletries', '保養品');
  add('toiletries', '化妝品 / 刮鬍刀');
  if (weather !== 'cold') add('toiletries', '防曬乳');
  if (weather === 'cold') {
    add('toiletries', '乳液 / 護手霜');
    add('toiletries', '護唇膏');
  }

  // 電子產品
  add('electronics', '手機充電器 / 線');
  add('electronics', '行動電源');
  add('electronics', '耳機');
  if (input.international) {
    add('electronics', '轉接頭');
    add('electronics', '網卡 / eSIM');
  }

  // 藥品 / 健康
  add('health', '常備藥（感冒 / 腸胃 / 止痛）');
  add('health', '個人處方藥');
  add('health', '口罩');
  if (input.climate === 'tropical' || weather === 'hot') add('health', '防蚊液');
  if (weather === 'cold') add('health', '暖暖包', Math.min(days, 10));

  // 其他
  add('other', '雨傘 / 雨衣');
  add('other', '環保袋');
  if (days >= 5) add('other', '洗衣袋 / 洗衣精');
  if (days >= 7) add('other', '備用摺疊袋（裝戰利品）');

  return out;
}

export function normalizePackingName(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

/** 範本與既有清單合併：名稱（去空白、不分大小寫）已存在的略過，避免重按「從範本產生」變兩份 */
export function filterNewTemplateItems(
  template: PackingTemplateItem[],
  existingNames: string[],
): PackingTemplateItem[] {
  const seen = new Set(existingNames.map(normalizePackingName));
  const out: PackingTemplateItem[] = [];
  for (const t of template) {
    const key = normalizePackingName(t.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export interface PackingProgress {
  packed: number;
  total: number;
  percent: number;
}

export function packingProgress(items: Array<{ packed: boolean }>): PackingProgress {
  const total = items.length;
  const packed = items.filter((i) => i.packed).length;
  return { packed, total, percent: total > 0 ? Math.round((packed / total) * 100) : 0 };
}
