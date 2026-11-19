import type {
  TaifexDriverType,
  TaifexEventType,
  TaifexExitReason,
  TaifexFactorKey,
  TaifexImportance,
  TaifexMode,
  TaifexProduct,
  TaifexOrderType,
  TaifexParams,
  TaifexTarget,
  TaifexVariantKey,
} from './types';

/** 與 GAS TAIFEX_PRODUCTS 一致；保證金為估計值，設定頁可覆寫 */
export const TAIFEX_PRODUCT_SPECS: Record<TaifexProduct, { label: string; name: string; pointValue: number; commission: number; margin: number }> = {
  TX: { label: '大台', name: '臺股期貨（TX）', pointValue: 200, commission: 60, margin: 350_000 },
  MTX: { label: '小台', name: '小型臺指（MTX）', pointValue: 50, commission: 30, margin: 87_500 },
  TMF: { label: '微台', name: '微型臺指（TMF）', pointValue: 10, commission: 15, margin: 17_500 },
};

export const TAIFEX_PRODUCTS: TaifexProduct[] = ['TMF', 'MTX', 'TX'];

export const TARGET_LABELS: Record<TaifexTarget, string> = { long: '做多', short: '做空', flat: '空手' };
export const SIDE_LABELS: Record<TaifexTarget, string> = { long: '多單', short: '空單', flat: '空手' };

export const MODE_LABELS: Record<TaifexMode, { label: string; desc: string }> = {
  auto: { label: '自動跟單', desc: '每天收盤後依訊號自動產生隔日開盤的虛擬單' },
  manual: { label: '只給建議', desc: '只顯示建議部位，由你手動下虛擬單' },
};

export const EXIT_REASON_LABELS: Record<TaifexExitReason, string> = {
  signal: '訊號出場',
  stop: '停損',
  reverse: '反手',
  manual: '手動',
  reset: '帳戶重置',
  halt: '熔斷平倉',
};

export const FACTOR_LABELS: Record<TaifexFactorKey, { label: string; desc: string; source: string }> = {
  trend: { label: '均線趨勢', desc: 'EMA20 與 EMA60 的距離、收盤相對 EMA60，以 ATR 標準化', source: 'Hurst, Ooi & Pedersen (2017)' },
  breakout: { label: '55 日通道', desc: '收盤在 55 日唐奇安通道中的位置', source: 'Donchian / Turtle' },
  tsmom: { label: '60 日動能', desc: '60 日報酬 ÷ 波動，時間序列動能', source: 'Moskowitz, Ooi & Pedersen (2012)' },
  foreignFlow: { label: '外資部位', desc: '外資台指期淨未平倉水位與 5 日變化（120 日 z-score）', source: 'Lai & Wang (2015)' },
  pcr: { label: '選擇權 PCR', desc: '臺指選擇權未平倉 Put/Call Ratio（120 日 z-score，高 = 下檔支撐）', source: 'Pan & Poteshman (2006)' },
};

export const EVENT_TYPE_LABELS: Record<TaifexEventType, string> = {
  fomc: 'FOMC',
  cpi: 'CPI',
  nfp: '非農',
  cbc: '央行',
  earnings: '財報 / 法說',
  settlement: '結算',
  holiday: '休市',
  geopolitical: '地緣政治',
  policy: '政策',
  other: '其他',
};

export const IMPORTANCE_LABELS: Record<TaifexImportance, string> = { high: '高', medium: '中', low: '低' };

export const DRIVER_LABELS: Record<TaifexDriverType, string> = {
  us_market: '美股',
  tsmc_adr: '台積電 ADR',
  fed: 'Fed',
  macro_data: '經濟數據',
  geopolitics: '地緣政治',
  foreign_flow: '外資動向',
  retail_sentiment: '散戶情緒',
  earnings: '財報',
  fx: '匯率',
  other: '其他',
};

export const SIZING_LIMIT_LABELS: Record<string, string> = {
  risk: '受每筆風險預算限制',
  margin: '受保證金使用率 40% 限制',
  maxContracts: '受最大口數限制',
  data: '資料不足',
};

export const VARIANT_LABELS: Record<TaifexVariantKey, { label: string; desc: string }> = {
  baseline: { label: '基準', desc: 'tx-v1 文獻預設參數（進場 ±0.35、停損 2×ATR、移動停損 3×ATR）' },
  conservative: { label: '保守', desc: '進場門檻 ±0.45、停損 2.5×ATR、移動停損 3.5×ATR：交易較少、給趨勢更多空間' },
  aggressive: { label: '積極', desc: '進場門檻 ±0.25、停損 1.5×ATR、移動停損 2.5×ATR：進出更頻繁' },
  optimized: { label: '最佳化', desc: '每週日以 walk-forward 在樣本內找報酬最高（回撤受限）的參數，下週套用' },
  tuned: { label: 'Claude 調校', desc: '每週檢討的調整提案經你核准後的參數（門檻、停損、因子權重）；還沒核准過任何提案時等同基準' },
};

export const ORDER_TYPE_LABELS: Record<TaifexOrderType, string> = {
  LMT: '限價',
  MWP: '範圍市價',
  MKT: '市價',
  STP: '停損單',
};

export const TIF_LABELS: Record<string, string> = {
  ROD: 'ROD 當日有效',
  IOC: 'IOC 立即成交否則取消',
  FOK: 'FOK 全部成交否則取消',
};

export function formatParams(params: Partial<TaifexParams>): string {
  const parts: string[] = [];
  if (params.entry !== undefined) parts.push(`進場 ±${params.entry}`);
  if (params.stopAtr !== undefined) parts.push(`停損 ${params.stopAtr}×ATR`);
  if (params.trailAtr !== undefined) parts.push(`移動 ${params.trailAtr}×ATR`);
  return parts.join('、') || '預設';
}

export function formatTWD(value: number | null | undefined, signed = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const text = Math.round(Math.abs(value)).toLocaleString('zh-TW');
  if (!signed) return `${value < 0 ? '-' : ''}${text}`;
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${text}`;
}

export function formatPoints(value: number | null | undefined, signed = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const text = Math.abs(value).toLocaleString('zh-TW', { maximumFractionDigits: 1 });
  if (!signed) return `${value < 0 ? '-' : ''}${text}`;
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${text}`;
}

export function formatPctValue(value: number | null | undefined, digits = 1, signed = true): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

/** 損益顏色：沿用 app 慣例（獲利綠、虧損紅） */
export function pnlClass(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return '';
  return value > 0 ? 'text-success' : 'text-destructive';
}
