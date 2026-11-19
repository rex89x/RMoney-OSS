import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { useBudget, useCategories, useTransactions, useUpsertBudget } from '../hooks';
import { useMyExpenseShare } from '../use-my-share';
import { nowTW, monthTWRange } from '@/lib/tz';
import { cn } from '@/lib/utils';

export function BudgetEditor() {
  const tw = nowTW();
  const monthKey = `${tw.getFullYear()}-${String(tw.getMonth() + 1).padStart(2, '0')}`;
  const { start, end } = monthTWRange(tw.getFullYear(), tw.getMonth() + 1);
  const { data: existing } = useBudget(monthKey);
  const { data: categories = [] } = useCategories();
  const { data: txs = [] } = useTransactions({ startDate: start, endDate: end, type: 'expense', limit: 1000 });
  const upsert = useUpsertBudget();

  const myShare = useMyExpenseShare();
  const spentByCat = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of txs) {
      const k = t.category || 'other';
      m[k] = (m[k] ?? 0) + myShare(t);
    }
    return m;
  }, [txs, myShare]);
  const totalSpent = useMemo(() => Object.values(spentByCat).reduce((s, v) => s + v, 0), [spentByCat]);

  const [total, setTotal] = useState('');
  const [byCategory, setByCategory] = useState<Record<string, string>>({});

  useEffect(() => {
    setTotal(existing?.total?.toString() ?? '');
    const map: Record<string, string> = {};
    if (existing?.byCategory) {
      for (const [k, v] of Object.entries(existing.byCategory)) {
        map[k] = String(v);
      }
    }
    setByCategory(map);
  }, [existing]);

  async function handleSave() {
    const byCat: Record<string, number> = {};
    for (const [k, v] of Object.entries(byCategory)) {
      const n = parseFloat(v);
      if (!isNaN(n) && n >= 0) byCat[k] = n;
    }
    await upsert.mutateAsync({
      id: existing?.id,
      budget: {
        month: monthKey,
        total: parseFloat(total) || 0,
        byCategory: byCat,
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{monthKey} 預算</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label>總預算 (TWD)</Label>
          <Input
            type="number"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            placeholder={`已花 ${Math.round(totalSpent).toLocaleString()}`}
          />
          {parseFloat(total) > 0 && (
            <div className="mt-2 space-y-1">
              <Progress value={Math.min(100, (totalSpent / parseFloat(total)) * 100)} />
              <p className="text-xs tabular-nums text-muted-foreground">
                已花 {Math.round(totalSpent).toLocaleString()} / {Math.round(parseFloat(total)).toLocaleString()}
                {' · '}
                <span className={totalSpent > parseFloat(total) ? 'text-destructive' : ''}>
                  {totalSpent > parseFloat(total) ? '超出 ' : '剩餘 '}
                  {Math.abs(parseFloat(total) - totalSpent).toFixed(0)}
                </span>
              </p>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label>各類別預算</Label>
          {categories.filter((c) => c.type === 'expense').map((c) => {
            const spent = spentByCat[c.key] ?? 0;
            const cap = parseFloat(byCategory[c.key] ?? '');
            const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
            const over = cap > 0 && spent > cap;
            return (
              <div key={c.key} className="rounded-md border p-3">
                <div className="grid grid-cols-[1fr,140px] items-center gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="size-3 shrink-0 rounded-full"
                      style={{ backgroundColor: c.color ?? '#94a3b8' }}
                    />
                    <span className="text-sm font-medium">{c.name}</span>
                  </div>
                  <Input
                    type="number"
                    placeholder="0"
                    value={byCategory[c.key] ?? ''}
                    onChange={(e) =>
                      setByCategory((prev) => ({ ...prev, [c.key]: e.target.value }))
                    }
                  />
                </div>
                {(cap > 0 || spent > 0) && (
                  <div className="mt-2 space-y-0.5">
                    <Progress value={pct} className={cn(over && '[&>div]:bg-destructive')} />
                    <p className="text-[11px] tabular-nums text-muted-foreground">
                      已花 {Math.round(spent).toLocaleString()}
                      {cap > 0 && (
                        <>
                          {' / '}{Math.round(cap).toLocaleString()}
                          <span className={over ? ' ml-2 text-destructive' : ' ml-2'}>
                            ({pct.toFixed(0)}%)
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <Button onClick={handleSave} disabled={upsert.isPending}>
          {upsert.isPending ? '儲存中…' : '儲存'}
        </Button>
      </CardContent>
    </Card>
  );
}
