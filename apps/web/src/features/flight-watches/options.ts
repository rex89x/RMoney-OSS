import type { ComboboxOption } from '@/components/ui/combobox';
import type { FlightCabin, FlightScanProvider, FlightTripType, FlightWatch } from './types';

export const TRIP_TYPE_LABELS: Record<FlightTripType, string> = {
  roundtrip: '來回',
  oneway: '單程',
  openjaw: '多點進出',
};

export const TICKET_SEARCH_OPTIONS: Array<{ value: 'both' | 'single' | 'separate'; label: string; hint: string }> = [
  { value: 'both', label: '兩種都比', hint: '一張票與拼單程都查，取較便宜' },
  { value: 'single', label: '只要一張票', hint: '來回 / 多城市同一張票，轉機延誤有保障' },
  { value: 'separate', label: '只看拼單程', hint: '去回各買一張單程，常比較便宜' },
];

export const TICKETING_LABELS = { single: '一張票', separate: '拼單程' } as const;

export const DEFAULT_CLAUDE_GROUP_LABEL = '預設群組';

export function claudeGroupLabel(group: string): string {
  return group.trim() || DEFAULT_CLAUDE_GROUP_LABEL;
}

export const CABIN_LABELS: Record<FlightCabin, string> = {
  economy: '經濟艙',
  premium_economy: '豪華經濟艙',
  business: '商務艙',
  first: '頭等艙',
};

export const FLIGHT_PROVIDER_LABELS: Record<FlightScanProvider, string> = {
  duffel: 'Duffel 即時票價 API',
  claude_api: 'Claude API + Web Search',
  claude: 'Claude 排程推送（不另付 API 費用）',
};

export const AIRPORT_OPTIONS: ComboboxOption[] = [
  { value: 'TPE', label: 'TPE 桃園國際機場', description: '台北／桃園' },
  { value: 'TSA', label: 'TSA 台北松山機場', description: '台北' },
  { value: 'KHH', label: 'KHH 高雄國際機場', description: '高雄' },
  { value: 'RMQ', label: 'RMQ 台中國際機場', description: '台中' },
  { value: 'NRT', label: 'NRT 成田國際機場', description: '東京' },
  { value: 'HND', label: 'HND 羽田機場', description: '東京' },
  { value: 'KIX', label: 'KIX 關西國際機場', description: '大阪／京都' },
  { value: 'NGO', label: 'NGO 中部國際機場', description: '名古屋' },
  { value: 'FUK', label: 'FUK 福岡機場', description: '福岡' },
  { value: 'OKA', label: 'OKA 那霸機場', description: '沖繩' },
  { value: 'CTS', label: 'CTS 新千歲機場', description: '札幌／北海道' },
  { value: 'ICN', label: 'ICN 仁川國際機場', description: '首爾' },
  { value: 'GMP', label: 'GMP 金浦國際機場', description: '首爾' },
  { value: 'PUS', label: 'PUS 金海國際機場', description: '釜山' },
  { value: 'HKG', label: 'HKG 香港國際機場', description: '香港' },
  { value: 'MFM', label: 'MFM 澳門國際機場', description: '澳門' },
  { value: 'PVG', label: 'PVG 上海浦東國際機場', description: '上海' },
  { value: 'PEK', label: 'PEK 北京首都國際機場', description: '北京' },
  { value: 'BKK', label: 'BKK 蘇凡納布機場', description: '曼谷' },
  { value: 'DMK', label: 'DMK 廊曼國際機場', description: '曼谷' },
  { value: 'SIN', label: 'SIN 樟宜機場', description: '新加坡' },
  { value: 'KUL', label: 'KUL 吉隆坡國際機場', description: '吉隆坡' },
  { value: 'DPS', label: 'DPS 峇里島伍拉賴機場', description: '峇里島' },
  { value: 'SGN', label: 'SGN 新山一國際機場', description: '胡志明市' },
  { value: 'HAN', label: 'HAN 內排國際機場', description: '河內' },
  { value: 'MNL', label: 'MNL 尼諾伊艾奎諾機場', description: '馬尼拉' },
  { value: 'SYD', label: 'SYD 雪梨機場', description: '雪梨' },
  { value: 'MEL', label: 'MEL 墨爾本機場', description: '墨爾本' },
  { value: 'LAX', label: 'LAX 洛杉磯國際機場', description: '洛杉磯' },
  { value: 'SFO', label: 'SFO 舊金山國際機場', description: '舊金山' },
  { value: 'JFK', label: 'JFK 甘迺迪國際機場', description: '紐約' },
  { value: 'YVR', label: 'YVR 溫哥華國際機場', description: '溫哥華' },
  { value: 'LHR', label: 'LHR 希斯洛機場', description: '倫敦' },
  { value: 'CDG', label: 'CDG 戴高樂機場', description: '巴黎' },
  { value: 'FRA', label: 'FRA 法蘭克福機場', description: '法蘭克福' },
  { value: 'AMS', label: 'AMS 阿姆斯特丹史基浦機場', description: '阿姆斯特丹' },
];

export const AIRLINE_OPTIONS: ComboboxOption[] = [
  { value: 'BR', label: 'BR 長榮航空', description: 'EVA Air' },
  { value: 'CI', label: 'CI 中華航空', description: 'China Airlines' },
  { value: 'JX', label: 'JX 星宇航空', description: 'STARLUX Airlines' },
  { value: 'NH', label: 'NH 全日空', description: 'ANA' },
  { value: 'JL', label: 'JL 日本航空', description: 'Japan Airlines' },
  { value: 'KE', label: 'KE 大韓航空', description: 'Korean Air' },
  { value: 'OZ', label: 'OZ 韓亞航空', description: 'Asiana Airlines' },
  { value: 'CX', label: 'CX 國泰航空', description: 'Cathay Pacific' },
  { value: 'SQ', label: 'SQ 新加坡航空', description: 'Singapore Airlines' },
  { value: 'TG', label: 'TG 泰國航空', description: 'Thai Airways' },
  { value: 'EK', label: 'EK 阿聯酋航空', description: 'Emirates' },
  { value: 'QR', label: 'QR 卡達航空', description: 'Qatar Airways' },
  { value: 'TK', label: 'TK 土耳其航空', description: 'Turkish Airlines' },
  { value: 'UA', label: 'UA 聯合航空', description: 'United Airlines' },
  { value: 'DL', label: 'DL 達美航空', description: 'Delta Air Lines' },
  { value: 'AA', label: 'AA 美國航空', description: 'American Airlines' },
  { value: 'AC', label: 'AC 加拿大航空', description: 'Air Canada' },
  { value: 'TR', label: 'TR 酷航', description: 'Scoot／廉價航空' },
  { value: 'IT', label: 'IT 台灣虎航', description: 'Tigerair Taiwan／廉價航空' },
  { value: 'MM', label: 'MM 樂桃航空', description: 'Peach／廉價航空' },
  { value: 'GK', label: 'GK 捷星日本', description: 'Jetstar Japan／廉價航空' },
  { value: 'FD', label: 'FD 泰國亞洲航空', description: 'Thai AirAsia／廉價航空' },
  { value: 'VZ', label: 'VZ 泰越捷航空', description: 'Thai VietJet／廉價航空' },
];

export function airportLabel(code: string): string {
  return AIRPORT_OPTIONS.find((option) => option.value === code)?.label ?? code;
}

export function airlineLabel(code: string): string {
  return AIRLINE_OPTIONS.find((option) => option.value === code)?.label ?? code;
}

/** 卡片、圖表、提示詞共用的航線名稱：「TPE → NRT · 寒假」 */
type RouteFields = Pick<FlightWatch, 'origin' | 'destination'> & Partial<Pick<FlightWatch, 'tripType' | 'returnOrigin' | 'returnDestination'>>;

/** 航線文字：「TPE → NRT」；多點進出「TPE → NRT ／ KIX → TPE」 */
export function flightRouteText(watch: RouteFields): string {
  const outbound = `${watch.origin} → ${watch.destination}`;
  if (watch.tripType !== 'openjaw') return outbound;
  return `${outbound} ／ ${watch.returnOrigin || watch.destination} → ${watch.returnDestination || watch.origin}`;
}

/** 卡片、圖表、提示詞共用的航線名稱：「TPE → NRT · 寒假」 */
export function flightWatchTitle(watch: RouteFields & Pick<FlightWatch, 'segmentLabel'>): string {
  const route = flightRouteText(watch);
  return watch.segmentLabel ? `${route} · ${watch.segmentLabel}` : route;
}

/** 同一條航線（出發、抵達相同；多點進出再加回程兩端）的多個日期區段分在同一組 */
export function flightRouteKey(watch: RouteFields): string {
  const base = `${watch.origin}-${watch.destination}`;
  return watch.tripType === 'openjaw'
    ? `${base}~${watch.returnOrigin || watch.destination}-${watch.returnDestination || watch.origin}`
    : base;
}
