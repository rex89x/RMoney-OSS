import type {
  StockRadarAction,
  StockRadarBucketKey,
  StockRadarEventType,
  StockRadarFactorKey,
  StockRadarMarket,
  StockRadarRegime,
} from './types';

export const MARKET_LABELS: Record<StockRadarMarket, string> = { TW: '台股', US: '美股' };

export type ActionTone = 'good' | 'plain' | 'warn' | 'bad' | 'muted';

export const ACTION_META: Record<StockRadarAction, { label: string; tone: ActionTone; held: boolean | null }> = {
  add: { label: '加碼', tone: 'good', held: true },
  hold: { label: '續抱', tone: 'plain', held: true },
  trim: { label: '減碼', tone: 'warn', held: true },
  exit: { label: '出場', tone: 'bad', held: true },
  buy: { label: '買進候選', tone: 'good', held: false },
  watch: { label: '觀望', tone: 'plain', held: false },
  avoid: { label: '避開', tone: 'bad', held: false },
  insufficient: { label: '資料不足', tone: 'muted', held: null },
};

/** 今日清單的分組順序：先處理持股風險，再看機會 */
export const ACTION_ORDER: StockRadarAction[] = ['exit', 'trim', 'add', 'buy', 'hold', 'watch', 'avoid', 'insufficient'];

export const REGIME_META: Record<StockRadarRegime, { label: string; description: string; tone: ActionTone }> = {
  risk_on: { label: '偏多', description: '大盤站上 200 日均線且 12 個月動能為正', tone: 'good' },
  neutral: { label: '中性', description: '均線與動能訊號分歧', tone: 'plain' },
  risk_off: { label: '偏空', description: '大盤跌破 200 日均線且 12 個月動能為負：不建議加碼，買進門檻提高', tone: 'bad' },
  unknown: { label: '未知', description: '大盤歷史資料不足', tone: 'muted' },
};

export const REASON_LABELS: Record<string, string> = {
  insufficient_history: '歷史 K 線不足',
  below_stop: '跌破吊燈停損',
  regime_risk_off: '大盤偏空',
  score_very_weak: '綜合分數極弱',
  score_weak: '綜合分數偏弱',
  score_strong: '綜合分數強',
  concentration: '持股占比已達上限',
  event_risk: '近期有財報／重大事件，暫緩加碼',
  market_sentiment: '市場整體輿情偏空，盤勢下修一級',
};

export const EVENT_TYPE_LABELS: Record<StockRadarEventType, string> = {
  earnings: '財報',
  ex_dividend: '除權息',
  offering: '增資／發債',
  legal: '訴訟／裁罰',
  downgrade: '降評',
  upgrade: '升評',
  guidance: '財測',
  macro: '總經',
  other: '其他',
};

export const SURPRISE_LABELS = { beat: '財報優於預期', miss: '財報低於預期', inline: '財報符合預期' } as const;

export const BUCKET_LABELS: Record<StockRadarBucketKey, string> = {
  strong: '≥ +0.35（加碼／買進區）',
  positive: '0 ~ +0.35',
  weak: '-0.15 ~ 0',
  very_weak: '< -0.15（減碼區）',
};

export function reasonLabel(key: string): string {
  return REASON_LABELS[key] ?? key;
}

export interface FactorMeta {
  label: string;
  /** 一句話說明分數怎麼算 */
  description: string;
  /** 文獻出處 */
  paper: string;
  weight: number;
  /** raw 值的顯示方式 */
  rawFormat: 'pct' | 'ratio';
  twOnly?: boolean;
}

/** 權重與 apps-script/src/StockRadarFactors.gs STOCK_RADAR_FACTOR_WEIGHTS 一致 */
export const FACTOR_META: Record<StockRadarFactorKey, FactorMeta> = {
  tsmom: {
    label: '時間序列動能',
    description: '過去 12 個月（跳過最近 1 個月）報酬 ÷ 年化波動率',
    paper: 'Moskowitz, Ooi & Pedersen (2012), Time Series Momentum, JFE',
    weight: 1,
    rawFormat: 'pct',
  },
  relMom: {
    label: '相對動能 12-1',
    description: '12-1 報酬減去大盤（0050 / SPY）同期報酬',
    paper: 'Jegadeesh & Titman (1993), J. Finance；Asness, Moskowitz & Pedersen (2013)',
    weight: 1,
    rawFormat: 'pct',
  },
  high52: {
    label: '52 週高點',
    description: '收盤價 ÷ 52 週最高價，越接近高點分數越高',
    paper: 'George & Hwang (2004), The 52-Week High and Momentum Investing, J. Finance',
    weight: 1,
    rawFormat: 'ratio',
  },
  trend: {
    label: '長期趨勢',
    description: '收盤價相對 200 日均線的乖離',
    paper: 'Faber (2007)；Brock, Lakonishok & LeBaron (1992), J. Finance',
    weight: 1,
    rawFormat: 'pct',
  },
  reversal: {
    label: '短期反轉',
    description: '最近 1 個月漲太急扣分、跌深加分（以自身波動標準化）',
    paper: 'Lehmann (1990), QJE；Jegadeesh (1990), J. Finance',
    weight: 0.5,
    rawFormat: 'pct',
  },
  lowVol: {
    label: '低波動',
    description: '60 日年化波動率，30% 為中性，越低分數越高',
    paper: 'Ang, Hodrick, Xing & Zhang (2006)；Frazzini & Pedersen (2014)',
    weight: 0.5,
    rawFormat: 'pct',
  },
  instFlow: {
    label: '法人籌碼',
    description: '近 20 日外資 + 投信淨買超占成交量，5% 約 +0.76（上市股票）',
    paper: 'Richards (2005), JFQA；台股外資流量實證',
    weight: 0.5,
    rawFormat: 'pct',
    twOnly: true,
  },
  marginChange: {
    label: '融資變化',
    description: '近 20 日融資餘額變化，散戶加槓桿過熱扣分（反向指標）',
    paper: 'Baker & Wurgler (2006), J. Finance 投資人情緒',
    weight: 0.25,
    rawFormat: 'pct',
    twOnly: true,
  },
};

/** 輿情權重說明，與 apps-script STOCK_RADAR_SENTIMENT 一致 */
export const SENTIMENT_RULES = {
  weight: 0.25,
  pead: 0.05,
  maxAdj: 0.3,
} as const;

export function formatPct(value: number | null, digits = 1, signed = true): string {
  if (value === null) return '—';
  const pct = value * 100;
  return `${signed && pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}

export function formatFactorRaw(key: StockRadarFactorKey, raw: number | null): string {
  if (raw === null) return '—';
  if (FACTOR_META[key].rawFormat === 'ratio') return `${(raw * 100).toFixed(1)}%`;
  const pct = raw * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

export function formatScore(score: number | null): string {
  if (score === null) return '—';
  return `${score >= 0 ? '+' : ''}${score.toFixed(2)}`;
}

export function formatPrice(value: number | null, currency: string): string {
  if (value === null) return '—';
  const digits = currency === 'TWD' && value >= 100 ? 1 : 2;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
