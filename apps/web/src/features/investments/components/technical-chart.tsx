import { useMemo, useState } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { cn } from '@/lib/utils';
import {
  bollingerBands, ema, macd, rsi, sma,
} from '@/lib/indicators';

export interface TechnicalSeries {
  date: string;        // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

type Range = '1M' | '3M' | '6M' | '1Y' | 'ALL';

const RANGE_OPTIONS: { key: Range; label: string; days: number | null }[] = [
  { key: '1M', label: '1M', days: 30 },
  { key: '3M', label: '3M', days: 90 },
  { key: '6M', label: '6M', days: 180 },
  { key: '1Y', label: '1Y', days: 365 },
  { key: 'ALL', label: 'ALL', days: null },
];

type IndicatorKey = 'sma5' | 'sma20' | 'sma60' | 'ema12' | 'ema26' | 'bb';

const INDICATOR_OPTS: { key: IndicatorKey; label: string; color: string }[] = [
  { key: 'sma5', label: 'SMA 5', color: '#60a5fa' },
  { key: 'sma20', label: 'SMA 20', color: '#f59e0b' },
  { key: 'sma60', label: 'SMA 60', color: '#a78bfa' },
  { key: 'ema12', label: 'EMA 12', color: '#34d399' },
  { key: 'ema26', label: 'EMA 26', color: '#f472b6' },
  { key: 'bb', label: 'Bollinger', color: '#94a3b8' },
];

export interface TechnicalChartProps {
  data: TechnicalSeries[];
  showVolume?: boolean;
  pricePrecision?: number;
  heightMain?: number;
  heightSub?: number;
  defaultRange?: Range;
  defaultIndicators?: IndicatorKey[];
  showRsi?: boolean;
  showMacd?: boolean;
}

export function TechnicalChart({
  data,
  showVolume = true,
  pricePrecision = 2,
  heightMain = 280,
  heightSub = 120,
  defaultRange = '3M',
  defaultIndicators = ['sma5', 'sma20', 'sma60'],
  showRsi = true,
  showMacd = true,
}: TechnicalChartProps) {
  const [range, setRange] = useState<Range>(defaultRange);
  const [indicators, setIndicators] = useState<Set<IndicatorKey>>(new Set(defaultIndicators));
  const [rsiOn, setRsiOn] = useState(showRsi);
  const [macdOn, setMacdOn] = useState(showMacd);

  const windowed = useMemo(() => {
    const days = RANGE_OPTIONS.find((r) => r.key === range)?.days;
    if (days == null || data.length <= days) return data;
    return data.slice(data.length - days);
  }, [data, range]);

  const closes = useMemo(() => windowed.map((d) => d.close), [windowed]);

  const series = useMemo(() => {
    const sma5 = sma(closes, 5);
    const sma20 = sma(closes, 20);
    const sma60 = sma(closes, 60);
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const bb = bollingerBands(closes, 20, 2);
    const rsi14 = rsi(closes, 14);
    const macdR = macd(closes, 12, 26, 9);
    return windowed.map((d, i) => ({
      date: d.date,
      close: d.close,
      open: d.open,
      high: d.high,
      low: d.low,
      volume: d.volume,
      sma5: finite(sma5[i]),
      sma20: finite(sma20[i]),
      sma60: finite(sma60[i]),
      ema12: finite(ema12[i]),
      ema26: finite(ema26[i]),
      bbUpper: finite(bb.upper[i]),
      bbLower: finite(bb.lower[i]),
      bbMiddle: finite(bb.middle[i]),
      rsi: finite(rsi14[i]),
      macd: finite(macdR.macd[i]),
      macdSignal: finite(macdR.signal[i]),
      macdHist: finite(macdR.hist[i]),
    }));
  }, [closes, windowed]);

  function toggleIndicator(key: IndicatorKey) {
    const next = new Set(indicators);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setIndicators(next);
  }

  const yDomain = useMemo(() => {
    if (series.length === 0) return ['auto', 'auto'] as const;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      if (Number.isFinite(s.low)) lo = Math.min(lo, s.low);
      if (Number.isFinite(s.high)) hi = Math.max(hi, s.high);
      if (indicators.has('bb')) {
        if (Number.isFinite(s.bbLower)) lo = Math.min(lo, s.bbLower as number);
        if (Number.isFinite(s.bbUpper)) hi = Math.max(hi, s.bbUpper as number);
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return ['auto', 'auto'] as const;
    const pad = (hi - lo) * 0.05 || hi * 0.01;
    return [lo - pad, hi + pad] as const;
  }, [series, indicators]);

  if (series.length === 0) {
    return (
      <div className="rounded-xl border p-6 text-sm text-muted-foreground">
        尚無歷史 K 線資料。請在設定頁點「回填 K 線」或等定時任務。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {RANGE_OPTIONS.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              className={cn(
                'h-8 rounded-md px-2.5 text-xs font-medium transition-colors',
                range === r.key
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="mx-2 h-6 w-px bg-border" aria-hidden />
        <div className="flex flex-wrap gap-1">
          {INDICATOR_OPTS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => toggleIndicator(opt.key)}
              className={cn(
                'h-7 rounded-md border px-2 text-[11px] font-medium transition-colors',
                indicators.has(opt.key)
                  ? 'border-transparent text-primary-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
              style={indicators.has(opt.key) ? { backgroundColor: opt.color } : undefined}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="mx-2 h-6 w-px bg-border" aria-hidden />
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setRsiOn((v) => !v)}
            className={cn(
              'h-7 rounded-md border px-2 text-[11px] font-medium transition-colors',
              rsiOn ? 'border-transparent bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >RSI</button>
          <button
            type="button"
            onClick={() => setMacdOn((v) => !v)}
            className={cn(
              'h-7 rounded-md border px-2 text-[11px] font-medium transition-colors',
              macdOn ? 'border-transparent bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >MACD</button>
        </div>
      </div>

      {/* 主圖: 價格 + SMA/EMA/BB */}
      <div style={{ height: heightMain }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="tcFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.25} />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="date" fontSize={10} stroke="hsl(var(--muted-foreground))" minTickGap={24} />
            <YAxis domain={yDomain as [number | string, number | string]} fontSize={10} stroke="hsl(var(--muted-foreground))" width={56}
              tickFormatter={(v: number) => v.toFixed(pricePrecision)} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? v.toFixed(pricePrecision) : v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Area type="monotone" dataKey="close" name="收盤" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#tcFill)" dot={false} isAnimationActive={false} />
            {indicators.has('bb') && (
              <>
                <Line type="monotone" dataKey="bbUpper" name="BB Upper" stroke="#94a3b8" strokeWidth={1} dot={false} strokeDasharray="3 3" isAnimationActive={false} />
                <Line type="monotone" dataKey="bbLower" name="BB Lower" stroke="#94a3b8" strokeWidth={1} dot={false} strokeDasharray="3 3" isAnimationActive={false} />
              </>
            )}
            {indicators.has('sma5') && <Line type="monotone" dataKey="sma5" name="SMA 5" stroke="#60a5fa" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
            {indicators.has('sma20') && <Line type="monotone" dataKey="sma20" name="SMA 20" stroke="#f59e0b" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
            {indicators.has('sma60') && <Line type="monotone" dataKey="sma60" name="SMA 60" stroke="#a78bfa" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
            {indicators.has('ema12') && <Line type="monotone" dataKey="ema12" name="EMA 12" stroke="#34d399" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
            {indicators.has('ema26') && <Line type="monotone" dataKey="ema26" name="EMA 26" stroke="#f472b6" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {showVolume && series.some((s) => (s.volume ?? 0) > 0) && (
        <div style={{ height: 70 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="date" hide />
              <YAxis fontSize={9} stroke="hsl(var(--muted-foreground))" width={56}
                tickFormatter={(v: number) => shortNum(v)} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? shortNum(v) : v)} />
              <Bar dataKey="volume" name="量" fill="hsl(var(--muted-foreground))" opacity={0.5} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {rsiOn && (
        <div style={{ height: heightSub }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="date" hide />
              <YAxis domain={[0, 100]} ticks={[0, 30, 50, 70, 100]} fontSize={10} stroke="hsl(var(--muted-foreground))" width={56} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? v.toFixed(2) : v)} />
              <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="3 3" />
              <ReferenceLine y={30} stroke="#22c55e" strokeDasharray="3 3" />
              <Line type="monotone" dataKey="rsi" name="RSI 14" stroke="#8b5cf6" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {macdOn && (
        <div style={{ height: heightSub }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="date" hide />
              <YAxis fontSize={10} stroke="hsl(var(--muted-foreground))" width={56}
                tickFormatter={(v: number) => v.toFixed(2)} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? v.toFixed(3) : v)} />
              <ReferenceLine y={0} stroke="hsl(var(--border))" />
              <Bar dataKey="macdHist" name="Hist" isAnimationActive={false}
                fill="#94a3b8"
                shape={(props: unknown) => {
                  const p = props as { x: number; y: number; width: number; height: number; payload: { macdHist: number } };
                  const pos = (p.payload.macdHist ?? 0) >= 0;
                  return <rect x={p.x} y={p.y} width={p.width} height={p.height} fill={pos ? '#22c55e' : '#ef4444'} fillOpacity={0.6} />;
                }}
              />
              <Line type="monotone" dataKey="macd" name="MACD" stroke="#3b82f6" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="macdSignal" name="Signal" stroke="#f97316" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function finite(n: number | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function shortNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

const tooltipStyle: React.CSSProperties = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '0.5rem',
  fontSize: 11,
};
