import { Plane, PlaneLanding, PlaneTakeoff } from 'lucide-react';
import { cn, formatCurrency } from '@/lib/utils';
import { formatFlightDate, formatFlightDuration } from '../dashboard';
import { CABIN_LABELS, TRIP_TYPE_LABELS, airportLabel } from '../options';
import { flightReturnLeg, type FlightTravelWindow, type FlightWatch } from '../types';

interface FlightTicketProps {
  watch: FlightWatch;
  window: FlightTravelWindow;
  /** 票卡上方的小標籤，例如「目前最低價」 */
  label?: string;
  className?: string;
}

/**
 * 登機證樣式的票卡：左邊是航段資訊、右邊（手機在下方）是價格存根，中間用打孔虛線分隔。
 * 只呈現資料，價格與日期都是最近一次掃描的結果。
 */
export function FlightTicket({ watch, window, label = '目前最低價', className }: FlightTicketProps) {
  const oneway = watch.tripType === 'oneway' || !window.returnDate;
  const openJaw = watch.tripType === 'openjaw';
  const separate = window.ticketing === 'separate';
  const returnLeg = flightReturnLeg(watch);
  const originCity = airportLabel(watch.origin).replace(/^[A-Z]{3}\s*/, '');
  const destinationCity = airportLabel(watch.destination).replace(/^[A-Z]{3}\s*/, '');
  const fields: Array<{ label: string; value: string }> = [
    { label: '出發日', value: formatFlightDate(window.departureDate) },
    oneway
      ? { label: '行程', value: TRIP_TYPE_LABELS.oneway }
      : { label: '回程日', value: formatFlightDate(window.returnDate) },
    { label: '艙等', value: CABIN_LABELS[window.cabin] },
    { label: '轉機', value: window.stops === 0 ? '直飛' : `${window.stops} 次` },
    { label: '飛行', value: window.durationMinutes ? formatFlightDuration(window.durationMinutes) : '—' },
    { label: '旅客', value: `${watch.adults} 位成人` },
  ];

  return (
    <article
      className={cn(
        'relative flex flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm sm:flex-row',
        className,
      )}
      aria-label={`${watch.origin} 到 ${watch.destination} ${label} ${formatCurrency(window.priceTWD)}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2 bg-primary/10 px-4 py-2 text-xs">
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-primary">
            <Plane className="size-3.5 shrink-0" />
            <span className="truncate">{window.airline || '航空公司待確認'}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {separate ? <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">拼單程</span> : null}
            <span className="font-mono tracking-wider text-muted-foreground">
              {window.flightNumber ?? (watch.segmentLabel || TRIP_TYPE_LABELS[watch.tripType])}
            </span>
          </span>
        </div>

        <div className="flex items-center gap-3 px-4 pt-4">
          <AirportBlock code={watch.origin} city={originCity} time={window.departureTime} icon="takeoff" />
          <div className="flex min-w-0 flex-1 flex-col items-center text-[10px] text-muted-foreground">
            <span>{window.durationMinutes ? formatFlightDuration(window.durationMinutes) : TRIP_TYPE_LABELS[watch.tripType]}</span>
            <div className="relative my-1 w-full">
              <div className="border-t-2 border-dashed border-muted-foreground/40" />
              <Plane className="absolute left-1/2 top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-card text-primary" />
            </div>
            <span>{window.stops === 0 ? '直飛' : `轉機 ${window.stops} 次`}</span>
          </div>
          <AirportBlock code={watch.destination} city={destinationCity} time={window.arrivalTime} icon="landing" align="right" />
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-4 py-4 text-xs min-[420px]:grid-cols-3">
          {fields.map((field) => (
            <div key={field.label} className="min-w-0">
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{field.label}</dt>
              <dd className="break-words font-medium tabular-nums">{field.value}</dd>
            </div>
          ))}
        </dl>
        {openJaw && returnLeg ? (
          <p className="-mt-2 flex flex-wrap items-center gap-x-1.5 px-4 pb-2 text-[11px] text-muted-foreground">
            <PlaneLanding className="size-3 shrink-0" />
            <span>多點進出：回程</span>
            <span className="font-mono font-semibold text-foreground">{returnLeg.from}</span>
            <span>→</span>
            <span className="font-mono font-semibold text-foreground">{returnLeg.to}</span>
            <span className="truncate">（{airportLabel(returnLeg.from).replace(/^[A-Z]{3}\s*/, '')} 出發）</span>
          </p>
        ) : null}
        {separate && window.outboundPriceTWD && window.returnPriceTWD ? (
          <p className="-mt-1 px-4 pb-2 text-[11px] text-muted-foreground">
            去程 <span className="font-medium tabular-nums text-foreground">{formatCurrency(window.outboundPriceTWD)}</span>
            {window.airline ? `（${window.airline}）` : ''}
            {' ＋ '}回程 <span className="font-medium tabular-nums text-foreground">{formatCurrency(window.returnPriceTWD)}</span>
            {window.returnAirline ? `（${window.returnAirline}）` : ''}
            ；兩張票各自獨立，行李與延誤不互保
          </p>
        ) : null}
        {!oneway && (window.returnDepartureTime || window.returnArrivalTime) ? (
          <p className="-mt-1 px-4 pb-3 text-[11px] text-muted-foreground">
            回程 {window.returnDepartureTime ?? '—'} 出發 · {window.returnArrivalTime ?? '—'} 抵達（當地時間）
          </p>
        ) : null}
      </div>

      {/* 打孔分隔線：桌面是直的、手機是橫的，兩端各挖一個半圓 */}
      <div className="relative border-t-2 border-dashed border-muted-foreground/30 sm:border-l-2 sm:border-t-0">
        <span className="absolute -left-2.5 -top-2.5 size-5 rounded-full border bg-background sm:-left-2.5 sm:-top-2.5" />
        <span className="absolute -right-2.5 -top-2.5 size-5 rounded-full border bg-background sm:-bottom-2.5 sm:-left-2.5 sm:right-auto sm:top-auto" />
      </div>

      <div className="flex shrink-0 flex-row flex-wrap items-center justify-between gap-3 px-4 py-3 sm:w-44 sm:flex-col sm:flex-nowrap sm:items-start sm:justify-center sm:py-4">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="whitespace-nowrap text-xl font-bold tabular-nums text-primary">{formatCurrency(window.priceTWD)}</div>
          <div className="text-[11px] text-muted-foreground">
            {TRIP_TYPE_LABELS[watch.tripType]}{separate ? '（拼單程）' : ''} · {watch.adults} 人合計含稅
          </div>
        </div>
        {watch.maxPriceTWD ? (
          <div className={cn('text-[11px]', window.priceTWD <= watch.maxPriceTWD ? 'text-success' : 'text-muted-foreground')}>
            {window.priceTWD <= watch.maxPriceTWD ? '已達理想價' : `理想價 ${formatCurrency(watch.maxPriceTWD)}`}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function AirportBlock({
  code,
  city,
  time,
  icon,
  align = 'left',
}: {
  code: string;
  city: string;
  time: string | undefined;
  icon: 'takeoff' | 'landing';
  align?: 'left' | 'right';
}) {
  const Icon = icon === 'takeoff' ? PlaneTakeoff : PlaneLanding;
  return (
    <div className={cn('shrink-0', align === 'right' && 'text-right')}>
      <div className="font-mono text-2xl font-bold leading-none tracking-tight sm:text-3xl">{code}</div>
      <div className="mt-1 max-w-[6rem] truncate text-[11px] text-muted-foreground">{city || code}</div>
      <div className={cn('mt-0.5 flex items-center gap-1 text-xs font-medium tabular-nums', align === 'right' && 'justify-end')}>
        <Icon className="size-3 text-muted-foreground" />
        {time ?? '--:--'}
      </div>
    </div>
  );
}
