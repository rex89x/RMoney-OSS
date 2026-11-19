import { Plus, Trash2, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn, uid } from '@/lib/utils';
import type { TxLineItem } from '../types';

interface MemberOption {
  /** stable id 給 paidFor 使用（uid 或 name） */
  id: string;
  /** display name */
  name: string;
}

interface Props {
  value: TxLineItem[];
  onChange: (next: TxLineItem[]) => void;
  /** 可選分攤對象；若為空則「指定分攤者」UI 隱藏，預設全 trip members 均分 */
  members?: MemberOption[];
  /** 顯示的總金額（給校驗用） */
  totalTWD?: number;
}

export function LineItemsEditor({ value, onChange, members = [], totalTWD }: Props) {
  function update(i: number, patch: Partial<TxLineItem>) {
    onChange(value.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([
      ...value,
      {
        id: uid('li'),
        name: '',
        amountTWD: 0,
        paidFor: members.map((m) => m.id),
      },
    ]);
  }
  function togglePaidFor(i: number, memberId: string) {
    const it = value[i];
    if (!it) return;
    const cur = it.paidFor ?? members.map((m) => m.id);
    const next = cur.includes(memberId) ? cur.filter((x) => x !== memberId) : [...cur, memberId];
    update(i, { paidFor: next });
  }
  function selectAll(i: number) {
    update(i, { paidFor: members.map((m) => m.id) });
  }
  function selectNone(i: number) {
    update(i, { paidFor: [] });
  }

  const sum = value.reduce((s, it) => s + (it.amountTWD || 0), 0);
  const mismatch = totalTWD != null && totalTWD > 0 && value.length > 0 && Math.abs(sum - totalTWD) > 0.5;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ListChecks className="size-4" /> 明細品項
          {value.length > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              小計 {Math.round(sum).toLocaleString()}
              {totalTWD != null ? ` / ${Math.round(totalTWD).toLocaleString()}` : ''}
              {mismatch && <span className="ml-1 text-destructive">差 {Math.round(sum - totalTWD!)}</span>}
            </span>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={add} type="button">
          <Plus className="size-4" /> 加品項
        </Button>
      </div>

      {value.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          沒有明細時，整筆按上方 trip 分攤規則處理。加上明細可指定哪幾位分攤哪些品項。
        </p>
      ) : (
        <ul className="space-y-2">
          {value.map((it, i) => {
            const sharers = it.paidFor ?? members.map((m) => m.id);
            return (
              <li key={it.id} className="rounded-md border p-3 space-y-2">
                <div className="grid gap-2 md:grid-cols-[1fr,120px,auto]">
                  <div>
                    <Label className="text-[11px]">品項</Label>
                    <Input
                      value={it.name}
                      onChange={(e) => update(i, { name: e.target.value })}
                      placeholder="鳳梨蝦球"
                    />
                  </div>
                  <div>
                    <Label className="text-[11px]">金額 (TWD)</Label>
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={it.amountTWD || ''}
                      onChange={(e) => update(i, { amountTWD: parseFloat(e.target.value) || 0 })}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button size="icon-sm" variant="ghost" onClick={() => remove(i)} type="button">
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                {members.length > 0 && (
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <Label className="text-[11px]">分攤對象（{sharers.length}/{members.length}）</Label>
                      <div className="flex gap-1 text-[11px]">
                        <button type="button" onClick={() => selectAll(i)} className="text-muted-foreground hover:underline">全選</button>
                        <span className="text-muted-foreground/50">·</span>
                        <button type="button" onClick={() => selectNone(i)} className="text-muted-foreground hover:underline">清除</button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {members.map((m) => {
                        const on = sharers.includes(m.id);
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => togglePaidFor(i, m.id)}
                            className={cn(
                              'rounded-full border px-2.5 py-1 text-xs transition-colors',
                              on ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
                            )}
                          >
                            {m.name}
                          </button>
                        );
                      })}
                    </div>
                    {sharers.length > 0 && it.amountTWD > 0 && (
                      <p className="mt-1 text-[10px] text-muted-foreground tabular-nums">
                        每人 {(it.amountTWD / sharers.length).toFixed(0)}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
