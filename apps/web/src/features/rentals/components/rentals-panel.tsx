import { useEffect, useMemo, useState } from 'react';
import {
  Building2, Calculator, Car, ChevronDown, ChevronRight, Edit3, Home, Package, Plus, Receipt, Trash2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useConfirm } from '@/components/ui/confirm';
import { formatCurrency, cn } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { useDeleteRentalIncome, useRentals } from '../hooks';
import {
  avgMonthlyIncomeTWD, estimateMonthsToPayback, netPnLTWD, paybackProgressPct, projectedPaybackDate,
  RENTAL_ASSET_TYPE_LABEL, totalReceivedTWD, type Rental, type RentalAssetType,
} from '../types';
import { RentalDialog } from './rental-dialog';
import { RecordIncomeDialog } from './record-income-dialog';

const TYPE_ICON: Record<RentalAssetType, typeof Package> = {
  equipment: Package,
  vehicle: Car,
  real_estate: Home,
  other: Building2,
};

export function RentalsPanel() {
  const { data: rentals = [], isLoading } = useRentals();
  const deleteIncome = useDeleteRentalIncome();
  const confirm = useConfirm();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Rental | null>(null);
  const [recording, setRecording] = useState<Rental | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const summary = useMemo(() => {
    const cost = rentals.reduce((s, r) => s + r.purchaseAmountTWD, 0);
    const received = rentals.reduce((s, r) => s + totalReceivedTWD(r), 0);
    const expected = rentals
      .filter((r) => r.status === 'active')
      .reduce((s, r) => s + r.expectedMonthlyIncome, 0);
    const overallProgress = cost > 0 ? Math.min(100, (received / cost) * 100) : 0;
    const remaining = Math.max(0, cost - received);
    const avgMonthly = rentals.reduce((s, r) => s + avgMonthlyIncomeTWD(r), 0);
    const monthsLeft = avgMonthly > 0 && remaining > 0 ? remaining / avgMonthly : null;
    return {
      cost,
      received,
      pnl: received - cost,
      expectedMonthly: expected,
      overallProgress,
      monthsLeft,
    };
  }, [rentals]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleDeleteIncome(rentalId: string, incomeId: string, label: string) {
    const ok = await confirm({
      title: '刪除這筆收款？',
      description: `${label} — 連動的 income TX 會進回收筒（7 天內可復原）`,
      confirmText: '刪除',
    });
    if (!ok) return;
    await deleteIncome.mutateAsync({ rentalId, incomeId });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 pb-2 sm:flex-row sm:items-center">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4" /> 租賃資產
            <span className="text-xs font-normal text-muted-foreground">
              （先支出買入，後續按月變動收款）
            </span>
          </CardTitle>
          <Button size="sm" onClick={() => { setEditing(null); setDialogOpen(true); }}>
            <Plus className="size-4" /> 新增
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="累積收款" value={formatCurrency(summary.received)} tone="success" />
            <Stat label="整體回本" value={`${summary.overallProgress.toFixed(1)}%`} tone="default" />
            <Stat
              label="預估剩餘"
              value={summary.monthsLeft != null
                ? `${summary.monthsLeft.toFixed(1)} 個月`
                : summary.cost > 0 && summary.received >= summary.cost
                  ? '已回本'
                  : '—'}
              tone="default"
            />
            <Stat label="預期月收" value={formatCurrency(summary.expectedMonthly)} tone="default" />
          </div>
          <p className="text-[11px] text-muted-foreground">
            累積成本 {formatCurrency(summary.cost)}（購入時已從帳戶扣除，未回收的部分以「租賃資產」虛擬科目回填淨值）
            {' · '}損益 {summary.pnl >= 0 ? '+' : ''}{formatCurrency(summary.pnl)}
          </p>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-md" />)}
        </div>
      ) : rentals.length === 0 ? (
        <Card>
          <CardContent className="space-y-2 py-10 text-center text-sm text-muted-foreground">
            <Building2 className="mx-auto size-6" />
            <p>還沒有租賃資產。點上方「新增」建立一筆。</p>
          </CardContent>
        </Card>
      ) : (
        rentals.map((r) => <RentalCard
          key={r.id}
          rental={r}
          expanded={expanded.has(r.id)}
          onToggle={() => toggle(r.id)}
          onEdit={() => { setEditing(r); setDialogOpen(true); }}
          onRecord={() => setRecording(r)}
          onDeleteIncome={(incomeId, label) => void handleDeleteIncome(r.id, incomeId, label)}
        />)
      )}

      <RentalDialog open={dialogOpen} onOpenChange={setDialogOpen} rental={editing} />
      <RecordIncomeDialog rental={recording} onClose={() => setRecording(null)} />
    </div>
  );
}

function RentalCard({
  rental, expanded, onToggle, onEdit, onRecord, onDeleteIncome,
}: {
  rental: Rental;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onRecord: () => void;
  onDeleteIncome: (incomeId: string, label: string) => void;
}) {
  const Icon = TYPE_ICON[rental.assetType];
  const received = totalReceivedTWD(rental);
  const net = netPnLTWD(rental);
  const avg = avgMonthlyIncomeTWD(rental);
  const progress = paybackProgressPct(rental);
  const baselineMonthly = avg > 0 ? avg : rental.expectedMonthlyIncome;
  const [whatIfInput, setWhatIfInput] = useState<string>(
    baselineMonthly > 0 ? String(Math.round(baselineMonthly)) : '',
  );

  useEffect(() => {
    setWhatIfInput(baselineMonthly > 0 ? String(Math.round(baselineMonthly)) : '');
  }, [baselineMonthly]);

  const whatIfMonthly = parseFloat(whatIfInput) || 0;
  const monthsLeft = estimateMonthsToPayback(rental, whatIfMonthly);
  const projDate = projectedPaybackDate(rental, whatIfMonthly);
  const remaining = Math.max(0, rental.purchaseAmountTWD - received);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Icon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{rental.name}</span>
              <Badge variant={rental.status === 'closed' ? 'secondary' : 'success'}>
                {rental.status === 'closed' ? '已結案' : RENTAL_ASSET_TYPE_LABEL[rental.assetType]}
              </Badge>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {formatTW(rental.startDate, 'yyyy/MM/dd')}
              {' · 成本 '}{formatCurrency(rental.purchaseAmountTWD)}
              {' · 累收 '}{formatCurrency(received)}
              {' · 月平均 '}{formatCurrency(avg)}
            </p>
          </div>
          {expanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
        </button>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" onClick={onRecord}>
            <Receipt className="size-3.5" /> 記款
          </Button>
          <Button size="icon-sm" variant="outline" onClick={onEdit} aria-label="編輯">
            <Edit3 className="size-3.5" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 px-4 pb-4">
        <div className="grid grid-cols-3 gap-2 rounded-md border p-2 text-xs">
          <ProgressStat label="回本進度" value={`${progress.toFixed(1)}%`} progress={progress} />
          <SmallStat
            label="淨損益"
            value={`${net >= 0 ? '+' : ''}${formatCurrency(net)}`}
            tone={net >= 0 ? 'success' : 'danger'}
          />
          <SmallStat
            label="共收幾期"
            value={`${rental.incomes.length} 期`}
          />
        </div>

        {remaining > 0 ? (
          <div className="rounded-md border bg-muted/20 p-3 text-xs">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <Calculator className="size-3" /> 回本推估（成本固定，月收可調）
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label className="text-[10px] text-muted-foreground">假設未來月收 TWD</label>
                <Input
                  type="number"
                  inputMode="decimal"
                  value={whatIfInput}
                  onChange={(e) => setWhatIfInput(e.target.value)}
                  className="mt-1 h-8 text-sm tabular-nums"
                  placeholder={baselineMonthly > 0 ? String(Math.round(baselineMonthly)) : '輸入月收金額'}
                />
                <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                  {[
                    avg > 0 ? { label: `平均 ${Math.round(avg)}`, value: avg } : null,
                    rental.expectedMonthlyIncome > 0
                      ? { label: `預期 ${Math.round(rental.expectedMonthlyIncome)}`, value: rental.expectedMonthlyIncome }
                      : null,
                    avg > 0 ? { label: `平均 × 1.2`, value: avg * 1.2 } : null,
                    avg > 0 ? { label: `平均 × 0.8`, value: avg * 0.8 } : null,
                  ].filter(Boolean).map((preset, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setWhatIfInput(String(Math.round(preset!.value)))}
                      className="rounded-full border px-2 py-0.5 text-muted-foreground hover:bg-muted"
                    >
                      {preset!.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <KV label="尚需收回" value={formatCurrency(remaining)} />
                {monthsLeft != null ? (
                  <>
                    <KV
                      label="預估月數"
                      value={`${monthsLeft.toFixed(1)} 個月（≈ ${(monthsLeft / 12).toFixed(1)} 年）`}
                      highlight
                    />
                    {projDate ? (
                      <KV label="預估回本日" value={formatTW(projDate, 'yyyy/MM/dd')} />
                    ) : null}
                  </>
                ) : (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    需要輸入 &gt; 0 的月收才能推估
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-success/40 bg-success/5 p-2 text-center text-xs text-success">
            已回本，後續收入皆為淨利
          </div>
        )}

        {expanded ? (
          <div className="space-y-1.5">
            {rental.incomes.length === 0 ? (
              <p className="rounded-md border bg-muted/20 p-3 text-center text-xs text-muted-foreground">
                還沒有收款紀錄。點右上「記款」建立第一筆。
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {rental.incomes.map((inc) => (
                  <li key={inc.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <Badge variant="outline" className="shrink-0">{inc.monthKey}</Badge>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-muted-foreground">
                        {formatTW(inc.date, 'yyyy/MM/dd')}
                        {inc.payerName ? ` · ${inc.payerName}` : ''}
                        {inc.note ? ` · ${inc.note}` : ''}
                      </div>
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-success">
                      +{formatCurrency(inc.amountTWD)}
                    </span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => onDeleteIncome(inc.id, `${inc.monthKey} · ${formatCurrency(inc.amountTWD)}`)}
                      aria-label="刪除"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'default' | 'success' | 'danger' }) {
  const cls = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-destructive' : 'text-foreground';
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-base font-semibold tabular-nums', cls)}>{value}</div>
    </div>
  );
}

function SmallStat({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'danger' }) {
  const cls = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-destructive' : '';
  return (
    <div className="text-center">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-sm font-medium tabular-nums', cls)}>{value}</div>
    </div>
  );
}

function KV({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('tabular-nums', highlight ? 'text-sm font-semibold' : '')}>{value}</span>
    </div>
  );
}

function ProgressStat({ label, value, progress }: { label: string; value: string; progress: number }) {
  return (
    <div className="text-center">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums">{value}</div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-success transition-all"
          style={{ width: `${Math.min(100, progress)}%` }}
        />
      </div>
    </div>
  );
}
