import { ClipboardList, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTW } from '@/lib/tz';
import { ORDER_TYPE_LABELS, TIF_LABELS, formatPoints, formatTWD } from '../options';
import type { TaifexOrderTicket } from '../types';

interface TaifexTicketCardProps {
  ticket: TaifexOrderTicket | null;
}

const KIND_LABELS: Record<TaifexOrderTicket['kind'], string> = {
  open: '新倉',
  close: '平倉',
  reverse: '反手',
  adjust: '調整口數',
  none: '不需下單',
};

/**
 * 下單建議單：把待成交單翻成「在券商要怎麼下」。虛擬帳戶會自動以開盤價成交；
 * 這張卡是給之後練習實單、或接券商前核對用。
 */
export function TaifexTicketCard({ ticket }: TaifexTicketCardProps) {
  const empty = !ticket || ticket.kind === 'none' || ticket.steps.length === 0;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <ClipboardList className="size-4" aria-hidden /> 下單建議
          {!empty && ticket ? <Badge variant="outline">{KIND_LABELS[ticket.kind]}</Badge> : null}
          {!empty && ticket?.validFrom ? <span className="text-xs font-normal text-muted-foreground">{ticket.validFrom} 開盤</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {empty || !ticket ? (
          <p className="text-xs text-muted-foreground">目前沒有待成交單，不需要下單；持倉中的話維持停損單即可。</p>
        ) : (
          <>
            <ol className="space-y-2">
              {ticket.steps.map((step, i) => (
                <li key={`${step.action}-${i}`} className="rounded-lg border p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-medium text-primary-foreground">{i + 1}</span>
                    <span className="font-medium">{step.label}</span>
                  </div>
                  <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
                    <Item label="買賣" value={`${step.side === 'buy' ? '買進' : '賣出'} ${step.qty} 口`} />
                    <Item label="委託" value={`${ORDER_TYPE_LABELS[step.orderType]}${step.price ? ` ${formatPoints(step.price)}` : ''}`} />
                    <Item label="時效" value={TIF_LABELS[step.tif] ?? step.tif} />
                    <Item label="開平倉" value={step.offset} />
                  </dl>
                </li>
              ))}
            </ol>
            {ticket.stopOrder ? (
              <div className="flex items-start gap-2 rounded-lg bg-warning/10 p-2.5 text-xs">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <div>
                  <p className="font-medium">
                    成交後掛停損單：{ticket.stopOrder.side === 'buy' ? '買進' : '賣出'} {ticket.stopOrder.qty} 口，觸價約 {formatPoints(ticket.stopOrder.price)}
                  </p>
                  <p className="text-muted-foreground">{ticket.stopOrder.note}</p>
                </div>
              </div>
            ) : null}
            <div className="grid grid-cols-3 gap-2 text-xs">
              <Box label="參考價" value={formatPoints(ticket.refPrice)} />
              <Box label="停損風險" value={ticket.riskTWD === null ? '—' : `${formatTWD(ticket.riskTWD)}（${ticket.riskPct ?? '—'}%）`} />
              <Box label="保證金（估）" value={formatTWD(ticket.marginTWD)} />
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {ticket.notes.map((n) => <li key={n} className="flex gap-1.5"><span aria-hidden>·</span>{n}</li>)}
            </ul>
            <p className="text-[11px] text-muted-foreground">
              虛擬帳戶會以開盤價自動成交，不需要你操作；這張單是給之後練習實單或接券商前核對用。
              {ticket.generatedAt ? ` 更新於 ${formatTW(ticket.generatedAt, 'MM/dd HH:mm')}（08:00 會依夜盤再更新一次）。` : ''}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function Box({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 p-2">
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium tabular-nums">{value}</p>
    </div>
  );
}
