import { useMemo, useState, cloneElement, isValidElement } from 'react';
import type { ReactElement, MouseEvent } from 'react';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DatePicker } from '@/components/ui/date-picker';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { useBulkSettle } from '../hooks';
import type { Transaction } from '../types';

interface Props {
  trigger: React.ReactNode;
  candidates: Transaction[];
}

export function BulkSettleDialog({ trigger, candidates }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [total, setTotal] = useState('');
  const [settledAt, setSettledAt] = useState<Date | null>(() => new Date());
  const settle = useBulkSettle();

  // 預設只列未結算且非 TWD 的
  const unsettled = useMemo(
    () => candidates.filter((t) => t.settledAmountTWD == null && t.currency !== 'TWD'),
    [candidates],
  );

  const selectedTxs = unsettled.filter((t) => selected.has(t.id));
  const estimatedTWD = selectedTxs.reduce((s, t) => s + t.amountTWD, 0);
  const totalNum = parseFloat(total);

  function toggleAll() {
    if (selected.size === unsettled.length) setSelected(new Set());
    else setSelected(new Set(unsettled.map((t) => t.id)));
  }
  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function handleSubmit() {
    if (!totalNum || !settledAt || selectedTxs.length === 0) return;
    await settle.mutateAsync({
      txIds: selectedTxs.map((t) => t.id),
      totalSettledTWD: totalNum,
      settledAt,
      txs: selectedTxs.map((t) => ({ id: t.id, amount: t.amount, fxRate: t.fxRate })),
    });
    setOpen(false);
    setSelected(new Set());
    setTotal('');
  }

  // ResponsiveDialog 沒有 Trigger，把 onClick 直接掛上原 trigger 元素打開 dialog
  const triggerElement = isValidElement(trigger)
    ? cloneElement(trigger as ReactElement<{ onClick?: (e: MouseEvent) => void }>, {
        onClick: (e: MouseEvent) => {
          (trigger as ReactElement<{ onClick?: (e: MouseEvent) => void }>).props.onClick?.(e);
          setOpen(true);
        },
      })
    : trigger;

  return (
    <>
      {triggerElement}
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title="批次結算"
        description="勾選同一張信用卡帳單涵蓋的交易，填入總入帳金額（TWD），系統按 amount×當時匯率 的相對比例分攤到每一筆。"
        contentClassName="sm:max-w-2xl"
        footer={
          <div className="space-y-3">
            {unsettled.length > 0 && (
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <Label>帳單實際入帳 (TWD)</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={total}
                    onChange={(e) => setTotal(e.target.value)}
                    placeholder={`估算 ${Math.round(estimatedTWD)}`}
                  />
                  {totalNum > 0 && estimatedTWD > 0 ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      差額 {(totalNum - estimatedTWD).toFixed(2)} ({((totalNum / estimatedTWD - 1) * 100).toFixed(2)}%)
                    </p>
                  ) : null}
                </div>
                <div>
                  <Label>結算日</Label>
                  <DatePicker value={settledAt} onChange={setSettledAt} clearable={false} />
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
              <Button
                onClick={() => void handleSubmit()}
                disabled={settle.isPending || !totalNum || selectedTxs.length === 0}
              >
                結算 {selectedTxs.length > 0 && `${selectedTxs.length} 筆`}
              </Button>
            </div>
          </div>
        }
      >
        {unsettled.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">沒有未結算的外幣交易</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Button size="sm" variant="ghost" onClick={toggleAll}>
                {selected.size === unsettled.length ? '全部取消' : '全選'} · {selected.size} / {unsettled.length}
              </Button>
              <span className="text-xs text-muted-foreground">估算小計 {formatCurrency(estimatedTWD)}</span>
            </div>
            <ul className="divide-y rounded-md border">
              {unsettled.map((t) => {
                const on = selected.has(t.id);
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => toggleOne(t.id)}
                      className="flex w-full items-center gap-3 p-3 text-left text-sm hover:bg-muted/50"
                    >
                      <input type="checkbox" checked={on} readOnly className="size-4" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{t.category}</span>
                          {t.tripId && <Badge variant="secondary" className="h-4 text-[9px]">出遊</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatTW(t.date, 'MM/dd')} · {t.paymentMethod}
                          {t.note ? ` · ${t.note}` : ''}
                        </div>
                      </div>
                      <div className="text-right text-sm">
                        <div className="tabular-nums">{t.amount} {t.currency}</div>
                        <div className="text-xs text-muted-foreground tabular-nums">≈ {formatCurrency(t.amountTWD)}</div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </ResponsiveDialog>
    </>
  );
}
