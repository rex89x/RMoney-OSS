import { useState } from 'react';
import { CalendarClock, CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { useConfirm } from '@/components/ui/confirm';
import { Badge } from '@/components/ui/badge';
import { addTWCalendarMonths, dateInputToTWDate, daysBetweenTWDates, formatDateInput, formatTW, startOfTWDay } from '@/lib/tz';
import { formatCurrency, cn } from '@/lib/utils';
import {
  useDeleteScheduledPayment, useMarkScheduledPaid, useScheduledPayments, useUpsertScheduledPayment,
} from '../hooks';
import { RECUR_LABEL, type PaymentRecurrence, type ScheduledPayment } from '../types';

export function ScheduledPaymentsPanel() {
  const { data: items = [], isLoading } = useScheduledPayments();
  const upsert = useUpsertScheduledPayment();
  const markPaid = useMarkScheduledPaid();
  const del = useDeleteScheduledPayment();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<ScheduledPayment | null>(null);

  function startNew() {
    const d = addTWCalendarMonths(startOfTWDay(), 1);
    setEditing({
      id: '', name: '', amountTWD: 0, dueDate: d, recurrence: 'yearly',
      remindBeforeDays: 7, paidAt: null, note: null, category: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
  }

  async function handleSave() {
    if (!editing) return;
    if (!editing.name.trim()) { toast.error('請輸入名稱'); return; }
    try {
      await upsert.mutateAsync({
        input: {
          name: editing.name.trim(),
          amountTWD: editing.amountTWD,
          dueDate: dateInputToTWDate(formatDateInput(editing.dueDate)) ?? editing.dueDate,
          recurrence: editing.recurrence,
          category: editing.category,
          remindBeforeDays: editing.remindBeforeDays,
          paidAt: editing.paidAt,
          note: editing.note?.trim() || null,
        },
        id: editing.id || undefined,
      });
      toast.success('已儲存');
      setEditing(null);
    } catch (err) {
      console.error('[scheduledPaymentSave]', err);
      toast.error(err instanceof Error ? err.message : '排程儲存失敗');
    }
  }

  async function handleDelete(p: ScheduledPayment) {
    const ok = await confirm({ title: '刪除排程？', description: p.name, confirmText: '刪除' });
    if (!ok) return;
    try {
      await del.mutateAsync(p.id);
      toast.success('已刪除');
    } catch (err) {
      console.error('[scheduledPaymentDelete]', err);
      toast.error(err instanceof Error ? err.message : '排程刪除失敗');
    }
  }

  const today = startOfTWDay();

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="size-4" /> 排程支出（保險 / 稅金 / 計畫支出）
          </CardTitle>
          <Button size="sm" variant="outline" onClick={startNew}><Plus className="size-4" /> 新增</Button>
        </CardHeader>
        <CardContent>
          {isLoading ? <p className="text-sm text-muted-foreground">載入中…</p> : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚未建立任何排程支出</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {items.map((p) => {
                const days = daysBetweenTWDates(today, p.dueDate);
                const overdue = days < 0 && !(p.recurrence === 'one-time' && p.paidAt);
                const upcoming = days >= 0 && days <= p.remindBeforeDays;
                const finishedOnce = p.recurrence === 'one-time' && p.paidAt;
                return (
                  <li key={p.id} className={cn('flex items-center gap-3 p-3 text-sm', finishedOnce && 'opacity-60')}>
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing({ ...p })}>
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{p.name}</span>
                        <Badge variant="outline" className="text-[10px]">{RECUR_LABEL[p.recurrence]}</Badge>
                        {overdue && <Badge variant="destructive" className="text-[10px]">已逾期 {-days} 天</Badge>}
                        {!overdue && upcoming && !finishedOnce && (
                          <Badge variant="outline" className="text-[10px] border-amber-500 text-amber-500">{days === 0 ? '今日' : `${days} 天後`}</Badge>
                        )}
                        {finishedOnce && <Badge variant="secondary" className="text-[10px]">已完成</Badge>}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {formatTW(p.dueDate, 'yyyy/MM/dd')}
                        {p.remindBeforeDays > 0 ? ` · 提前 ${p.remindBeforeDays} 天提醒` : ''}
                      </div>
                    </button>
                    <div className="text-right text-sm tabular-nums">{formatCurrency(p.amountTWD)}</div>
                    {!finishedOnce && (
                      <Button size="icon-sm" variant="ghost" onClick={() => void markPaid.mutateAsync(p.id)} aria-label="標記已繳">
                        <CheckCircle2 className="size-4" />
                      </Button>
                    )}
                    <Button size="icon-sm" variant="ghost" onClick={() => void handleDelete(p)} aria-label="刪除">
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <ResponsiveDialog
        open={!!editing}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        title={editing && editing.id ? '編輯排程' : '新增排程'}
        footer={
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setEditing(null)}>取消</Button>
            <Button className="flex-1" onClick={() => void handleSave()} disabled={upsert.isPending}>儲存</Button>
          </div>
        }
      >
        {editing && (
          <div className="space-y-3">
            <div><Label>名稱</Label>
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例：機車保險" autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>金額（TWD）</Label>
                <Input type="number" inputMode="decimal" value={Number.isFinite(editing.amountTWD) ? editing.amountTWD : ''}
                  onChange={(e) => setEditing({ ...editing, amountTWD: Number(e.target.value) })} />
              </div>
              <div><Label>頻率</Label>
                <Select value={editing.recurrence} onValueChange={(v) => setEditing({ ...editing, recurrence: v as PaymentRecurrence })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(RECUR_LABEL) as PaymentRecurrence[]).map((r) => (
                      <SelectItem key={r} value={r}>{RECUR_LABEL[r]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div><Label>到期日</Label>
              <DatePicker value={editing.dueDate} onChange={(d) => d && setEditing({ ...editing, dueDate: d })} clearable={false} />
            </div>
            <div><Label>提前 N 天提醒（0 為僅當天）</Label>
              <Input type="number" inputMode="numeric" min={0} max={60} value={editing.remindBeforeDays}
                onChange={(e) => setEditing({ ...editing, remindBeforeDays: Math.max(0, Number(e.target.value)) })} />
            </div>
            <div><Label>備註</Label>
              <Input value={editing.note ?? ''} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
            </div>
          </div>
        )}
      </ResponsiveDialog>
    </>
  );
}
