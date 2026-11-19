import { useMemo, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { Plus, Trash2, Target, Save } from 'lucide-react';
import { toast } from 'sonner';
import { doc, updateDoc } from 'firebase/firestore';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { db } from '@/lib/firebase';
import { useAuth } from '@/hooks/use-auth';
import { useAccounts } from '@/features/accounts/hooks';
import { formatCurrency, formatPercent, cn } from '@/lib/utils';
import { useLatestSnapshot } from '../hooks';
import type { AllocationTarget } from '@/types/global';

const PRESET_KEYS = [
  { key: 'TW', label: 'TW 股票', color: '#3b82f6' },
  { key: 'US', label: 'US 股票', color: '#8b5cf6' },
  { key: 'cash', label: '現金 / 等值', color: '#10b981' },
  { key: 'crypto', label: '加密貨幣', color: '#f59e0b' },
  { key: 'bond', label: '債券', color: '#06b6d4' },
];

export function AllocationVsTarget() {
  const { user, profile } = useAuth();
  const { data: snapshot, isLoading } = useLatestSnapshot();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const [targets, setTargets] = useState<AllocationTarget[]>(profile?.preferences?.allocationTargets ?? []);
  const [editing, setEditing] = useState(false);

  const totalPct = targets.reduce((s, t) => s + t.pct, 0);

  const data = useMemo(() => {
    if (!snapshot) return [];
    const cashTWD = accounts
      .filter((account) => ['cash', 'bank', 'investment_cash', 'e_wallet_balance'].includes(account.type))
      .reduce((sum, account) => sum + Math.max(0, account.balanceTWD), 0);
    const includesCash = targets.some((target) => target.key === 'cash');
    const total = snapshot.totalValueTWD + (includesCash ? cashTWD : 0);
    if (!total) return [];
    return targets.map((t) => {
      const actualValue = t.key === 'TW' || t.key === 'US'
        ? snapshot.byMarket[t.key as 'TW' | 'US']?.valueTWD ?? 0
        : t.key === 'cash'
          ? cashTWD
          : null;
      const actualPct = actualValue === null ? null : (actualValue / total) * 100;
      return {
        key: t.key,
        label: t.label,
        target: t.pct,
        actual: actualPct,
        actualValueTWD: actualValue,
        delta: actualPct === null ? null : actualPct - t.pct,
        color: t.color ?? PRESET_KEYS.find((p) => p.key === t.key)?.color ?? '#94a3b8',
      };
    });
  }, [accounts, snapshot, targets]);

  function addTarget() {
    const used = new Set(targets.map((t) => t.key));
    const candidate = PRESET_KEYS.find((p) => !used.has(p.key));
    setTargets([
      ...targets,
      candidate
        ? { key: candidate.key, label: candidate.label, pct: 0, color: candidate.color }
        : { key: `custom_${Date.now()}`, label: '自訂', pct: 0, color: '#94a3b8' },
    ]);
  }

  function removeTarget(key: string) {
    setTargets(targets.filter((t) => t.key !== key));
  }

  function updateTarget(key: string, patch: Partial<AllocationTarget>) {
    setTargets(targets.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  }

  async function save() {
    if (!user) return;
    if (Math.round(totalPct) !== 100 && targets.length > 0) {
      toast.error(`比例加總須為 100%（目前 ${totalPct.toFixed(0)}%）`);
      return;
    }
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        'preferences.allocationTargets': targets,
      });
      toast.success('已儲存配置目標');
      setEditing(false);
    } catch (err) {
      console.error('[saveAllocationTargets]', err);
      toast.error(err instanceof Error ? err.message : '儲存配置目標失敗');
    }
  }

  if (isLoading || accountsLoading) return <Skeleton className="h-64" />;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="size-4" /> 資產配置 vs 目標
        </CardTitle>
        {!editing ? (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>編輯目標</Button>
        ) : (
          <Button size="sm" onClick={() => void save()}><Save className="size-4" /> 儲存</Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {targets.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">尚未設定目標 — 例：60% TW / 40% US，或 70% 股 / 30% 現金</p>
            <Button size="sm" variant="outline" onClick={() => { setEditing(true); addTarget(); }}><Plus className="size-4" /> 新增第一筆</Button>
          </div>
        ) : (
          <>
            {data.length > 0 && (
              <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data} layout="vertical" margin={{ left: 60, right: 8, top: 4, bottom: 4 }}>
                    <XAxis type="number" tick={{ fontSize: 10 }} domain={[0, 100]} />
                    <YAxis dataKey="label" type="category" tick={{ fontSize: 10 }} width={64} />
                    <Tooltip formatter={(v, n) => {
                      const numericValue = typeof v === 'number' ? v : Number(v);
                      return [
                        Number.isFinite(numericValue) ? `${numericValue.toFixed(1)}%` : '未連結',
                        n === 'target' ? '目標' : '實際',
                      ];
                    }} />
                    <Legend formatter={(v) => <span className="text-xs">{v === 'target' ? '目標' : '實際'}</span>} />
                    <Bar dataKey="target" name="target" fill="#94a3b8" />
                    <Bar dataKey="actual" name="actual">
                      {data.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            <ul className="divide-y rounded-md border text-sm">
              {targets.map((t, i) => {
                const row = data[i];
                return (
                  <li key={t.key} className="flex items-center gap-2 p-2.5">
                    {editing ? (
                      <>
                        <Input value={t.label} onChange={(e) => updateTarget(t.key, { label: e.target.value })} className="h-8 flex-1" />
                        <Input type="number" inputMode="decimal" value={t.pct}
                          onChange={(e) => updateTarget(t.key, { pct: Number(e.target.value) })}
                          className="h-8 w-20" placeholder="%" />
                        <Button size="icon-sm" variant="ghost" onClick={() => removeTarget(t.key)}><Trash2 className="size-4" /></Button>
                      </>
                    ) : (
                      <>
                        <span className="size-2 rounded-full" style={{ backgroundColor: t.color ?? '#94a3b8' }} />
                        <span className="flex-1">{t.label}</span>
                        {row && row.actual !== null ? (
                          <>
                            <span className="text-xs text-muted-foreground">目標 {t.pct.toFixed(0)}%</span>
                            <span className={cn('text-xs tabular-nums',
                              row.delta !== null && Math.abs(row.delta) < 5 ? 'text-emerald-500' : 'text-amber-500')}>
                              實際 {formatPercent(row.actual, 1)}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {formatCurrency(row.actualValueTWD ?? 0)}
                            </span>
                          </>
                        ) : <span className="text-xs text-muted-foreground">尚未連結資產資料</span>}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>

            {editing && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>合計 {totalPct.toFixed(0)}%</span>
                {Math.round(totalPct) !== 100 && targets.length > 0 && <span className="text-amber-500">須為 100%</span>}
                <Button size="sm" variant="outline" onClick={addTarget}><Plus className="size-3" /> 新增類別</Button>
              </div>
            )}

            {data.length > 0 && !editing && (
              <p className="text-[11px] text-muted-foreground">
                實際比例以投資快照（台股／美股）及現金類帳戶計算；加密貨幣、債券與自訂類別在連結資料前顯示「尚未連結」，不會誤算為 0%。
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
