import { useEffect, useState } from 'react';
import { Loader2, Minus, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { useConfirm } from '@/components/ui/confirm';
import { cn, formatCurrency } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { summarizeLots, type HoldingLot } from '../calc';
import { useUpdateJointHolding } from '../hooks';
import { JointTradeFormSchema } from '../schema';
import type { JointHolding } from '../types';

interface TradeDialogProps {
  householdId: string;
  holding: JointHolding | null;
  canEdit: boolean;
  onOpenChange: (open: boolean) => void;
  /** 刪除整檔持股（確認對話框由呼叫端處理） */
  onDelete?: (holding: JointHolding) => void;
  deleting?: boolean;
}

/** 單一持股的交易紀錄：加碼 / 賣出 / 刪除某筆 */
export function TradeDialog({ householdId, holding, canEdit, onOpenChange, onDelete, deleting }: TradeDialogProps) {
  const update = useUpdateJointHolding();
  const confirm = useConfirm();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [date, setDate] = useState(() => new Date());
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [fee, setFee] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!holding) return;
    setSide('buy'); setDate(new Date()); setShares(''); setPrice(''); setFee(''); setError(null);
  }, [holding]);

  if (!holding) return null;
  const summary = summarizeLots(holding.lots);
  const linked = holding.source === 'portfolio';
  const editable = canEdit && !linked;

  async function saveLots(lots: HoldingLot[], message: string) {
    if (!holding) return;
    try {
      await update.mutateAsync({ householdId, id: holding.id, patch: { lots } });
      toast.success(message);
      setShares(''); setPrice(''); setFee('');
    } catch (err) {
      console.error('[saveJointTrade]', err);
    }
  }

  async function handleAdd() {
    if (!holding) return;
    const parsed = JointTradeFormSchema.safeParse({
      side, date,
      shares: shares === '' ? undefined : Number(shares),
      price: price === '' ? undefined : Number(price),
      fee: fee === '' ? 0 : Number(fee),
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? '資料不正確'); return; }
    if (parsed.data.side === 'sell' && parsed.data.shares > summary.shares + 1e-9) {
      setError(`目前只持有 ${summary.shares.toLocaleString('en-US')} 股`);
      return;
    }
    setError(null);
    await saveLots([...holding.lots, parsed.data], parsed.data.side === 'buy' ? '已記錄加碼' : '已記錄賣出');
  }

  async function handleDeleteLot(index: number) {
    if (!holding) return;
    const ok = await confirm({ title: '刪除這筆交易？', description: '持股數、成本與已實現損益會重新計算。', confirmText: '刪除' });
    if (!ok) return;
    const lots = holding.lots.filter((_, i) => i !== index);
    // 刪掉買進後若會「賣超過持股」，summarizeLots 會忽略超賣部分；這裡直接擋，避免歷史對不起來
    const check = [...lots].sort((a, b) => a.date.getTime() - b.date.getTime());
    let running = 0;
    for (const l of check) {
      running += l.side === 'buy' ? l.shares : -l.shares;
      if (running < -1e-9) { toast.error('刪掉這筆會讓之後的賣出超過持股，請先刪除後面的賣出'); return; }
    }
    await saveLots(lots, '已刪除');
  }

  const sortedLots = holding.lots
    .map((lot, index) => ({ lot, index }))
    .sort((a, b) => b.lot.date.getTime() - a.lot.date.getTime());

  return (
    <ResponsiveDialog
      open={holding !== null}
      onOpenChange={(next) => { if (!update.isPending) onOpenChange(next); }}
      title={`${holding.symbol} ${holding.name !== holding.symbol ? holding.name : ''}`}
      description={`持有 ${summary.shares.toLocaleString('en-US')} 股 · 均價 ${summary.avgCost.toFixed(2)} ${holding.currency}`}
      contentClassName="sm:max-w-lg"
      footer={canEdit && onDelete ? (
        <Button type="button" variant="ghost" className="h-11 w-full text-destructive hover:text-destructive" onClick={() => onDelete(holding)} disabled={deleting || update.isPending}>
          <Trash2 className="size-4" /> {linked ? '取消連結這檔' : '刪除這檔持股'}
        </Button>
      ) : undefined}
    >
      <div className="space-y-4">
        {linked ? (
          <p className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs">
            這檔是從投資組合連結過來的，股數與均價跟著「投資」頁同步（每天 07:00 / 18:00 自動，或在共同投資頁按「同步我的持股」）。要加減碼請到投資頁操作。
          </p>
        ) : null}

        {editable ? (
          <div className="space-y-3 rounded-lg border p-3">
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="買進或賣出">
              {(['buy', 'sell'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={side === s}
                  onClick={() => setSide(s)}
                  className={cn(
                    'flex h-10 items-center justify-center gap-1 rounded-md border text-sm font-medium transition-colors',
                    side === s ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                  )}
                >
                  {s === 'buy' ? <Plus className="size-4" /> : <Minus className="size-4" />}
                  {s === 'buy' ? '加碼買進' : '賣出'}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 sm:col-span-1">
                <Label>日期</Label>
                <div className="mt-1"><DatePicker value={date} onChange={(v) => { if (v) setDate(v); }} /></div>
              </div>
              <div>
                <Label htmlFor="jt-shares">股數</Label>
                <Input id="jt-shares" type="number" inputMode="decimal" value={shares} onChange={(e) => setShares(e.target.value)} className="mt-1 tabular-nums" />
              </div>
              <div>
                <Label htmlFor="jt-price">成交價（{holding.currency}）</Label>
                <Input id="jt-price" type="number" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="mt-1 tabular-nums" />
              </div>
              <div>
                <Label htmlFor="jt-fee">手續費 + 稅</Label>
                <Input id="jt-fee" type="number" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0" className="mt-1 tabular-nums" />
              </div>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <Button className="h-11 w-full" onClick={() => void handleAdd()} disabled={update.isPending}>
              {update.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              記錄{side === 'buy' ? '買進' : '賣出'}
            </Button>
          </div>
        ) : !linked ? (
          <p className="text-xs text-muted-foreground">這檔不是你可以編輯的持股，只能查看。</p>
        ) : null}

        <div>
          <h3 className="mb-1 text-sm font-medium">交易紀錄</h3>
          {sortedLots.length === 0 ? (
            <p className="text-sm text-muted-foreground">沒有交易紀錄</p>
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {sortedLots.map(({ lot, index }) => (
                <li key={`${index}-${lot.date.getTime()}`} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <span className={cn('mr-2 rounded px-1.5 py-0.5 text-xs font-medium', lot.side === 'buy' ? 'bg-muted' : 'bg-primary/10 text-primary')}>
                      {lot.side === 'buy' ? '買' : '賣'}
                    </span>
                    <span className="tabular-nums">{lot.shares.toLocaleString('en-US')} 股 @ {lot.price}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{formatTW(lot.date, 'yyyy/MM/dd')}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatCurrency(lot.shares * lot.price + (lot.side === 'buy' ? lot.fee : -lot.fee), holding.currency)}
                    </span>
                    {editable ? (
                      <Button size="icon-sm" variant="ghost" aria-label="刪除這筆交易" onClick={() => void handleDeleteLot(index)} disabled={update.isPending}>
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </ResponsiveDialog>
  );
}
