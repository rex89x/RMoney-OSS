import { useMemo, useState } from 'react';
import { CalendarClock, CheckCircle2, CircleDashed, Loader2, PiggyBank, Repeat, Settings2, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useAuth } from '@/hooks/use-auth';
import { resolveIcon } from '@/lib/icons';
import { cn, formatCurrency } from '@/lib/utils';
import { useCategories } from '@/features/ledger/hooks';
import type { Transaction } from '@/features/ledger/types';
import { useChargeFundPlanExpense, useFundPlanStatus } from '../hooks';
import { parseMonthKey, type FundContributionState, type FundExpenseState } from '../fund-plan';
import { HOUSEHOLD_FUND_COLOR, memberColor } from '../entries';
import { memberCan, type Household } from '../types';
import { HouseholdFundEntryDialog, type FundEntryPreset } from './household-fund-entry-dialog';
import { HouseholdFundPlanDialog } from './household-fund-plan-dialog';
import { MemberChip } from './member-chip';

const CONTRIBUTION_BADGE: Record<FundContributionState, { label: string; variant: 'success' | 'warning' | 'secondary' | 'outline' }> = {
  done: { label: '已存入', variant: 'success' },
  partial: { label: '部分存入', variant: 'warning' },
  due: { label: '待存入', variant: 'warning' },
  upcoming: { label: '未到日', variant: 'outline' },
  none: { label: '未設定', variant: 'secondary' },
};

const EXPENSE_BADGE: Record<FundExpenseState, { label: string; variant: 'success' | 'warning' | 'secondary' | 'outline' }> = {
  charged: { label: '已扣款', variant: 'success' },
  skipped: { label: '本月略過', variant: 'secondary' },
  due: { label: '待扣款', variant: 'warning' },
  upcoming: { label: '未到日', variant: 'outline' },
  paused: { label: '暫停', variant: 'secondary' },
};

interface HouseholdFundPlanCardProps {
  household: Household;
  /** 點已扣款的固定支出 → 開交易明細（可修改） */
  onOpenTx: (tx: Transaction) => void;
}

/** 公基金每月計畫：本月誰存了沒、固定扣款扣了沒、每月淨流入與可撐幾個月 */
export function HouseholdFundPlanCard({ household, onOpenTx }: HouseholdFundPlanCardProps) {
  const { user } = useAuth();
  const myUid = user?.uid ?? '';
  const { status } = useFundPlanStatus(household);
  const { data: categories = [] } = useCategories();
  const catMap = useMemo(() => Object.fromEntries(categories.map((c) => [c.key, c])), [categories]);
  const charge = useChargeFundPlanExpense();
  const [planOpen, setPlanOpen] = useState(false);
  const [preset, setPreset] = useState<FundEntryPreset | null>(null);
  /** 記錄存入 / 立即扣款 = 新增共同支出權限；調整計畫 = 公基金管理權限 */
  const canEdit = memberCan(household, myUid, 'canAddExpense');
  const canEditPlan = memberCan(household, myUid, 'canManageFund');
  const plan = household.fundPlan;

  if (!plan || !plan.enabled || !status) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: `${HOUSEHOLD_FUND_COLOR}1a` }}>
              <Repeat className="size-4" style={{ color: HOUSEHOLD_FUND_COLOR }} />
            </span>
            <div>
              <div className="text-sm font-medium">{plan ? '每月計畫已暫停' : '設定每月固定投入'}</div>
              <p className="text-xs text-muted-foreground">
                兩人每月各投入固定金額，房租、水電等固定支出到日自動從公基金扣款。
              </p>
            </div>
          </div>
          {canEditPlan ? (
            <Button size="sm" onClick={() => setPlanOpen(true)} className="shrink-0">
              <Settings2 className="size-4" /> {plan ? '調整計畫' : '開始設定'}
            </Button>
          ) : null}
        </CardContent>
        <HouseholdFundPlanDialog household={household} open={planOpen} onOpenChange={setPlanOpen} />
      </Card>
    );
  }

  const parsedMonth = parseMonthKey(status.monthKey);
  const monthLabel = parsedMonth ? `${parsedMonth.month} 月` : status.monthKey;
  const recordedTotal = status.contributions.reduce((sum, item) => sum + Math.min(item.recordedTWD, item.plannedTWD || item.recordedTWD), 0);
  const progress = status.plannedInflowTWD > 0 ? Math.min(100, (recordedTotal / status.plannedInflowTWD) * 100) : 0;

  function openRecord(remaining: number) {
    if (!parsedMonth) return;
    setPreset({
      amountTWD: remaining,
      planMonth: status?.monthKey ?? '',
      note: `${parsedMonth.year}/${String(parsedMonth.month).padStart(2, '0')} 每月固定存入`,
      date: new Date(),
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="size-4" style={{ color: HOUSEHOLD_FUND_COLOR }} /> {monthLabel}每月計畫
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            每月 {plan.dayOfMonth} 號存入{plan.autoRecord ? '（自動記錄）' : ''}
            {!status.active ? ` · ${plan.startMonth} 開始` : ''}
          </p>
        </div>
        {canEditPlan ? (
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => setPlanOpen(true)}>
            <Settings2 className="size-4" /> 調整
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">本月存入進度</span>
            <span className="tabular-nums">{formatCurrency(recordedTotal)} / {formatCurrency(status.plannedInflowTWD)}</span>
          </div>
          <Progress value={progress} className="mt-1 h-2" indicatorStyle={{ backgroundColor: HOUSEHOLD_FUND_COLOR }} />
        </div>

        <ul className="space-y-2">
          {status.contributions.map((item) => {
            const badge = CONTRIBUTION_BADGE[item.state];
            const remaining = Math.max(0, item.plannedTWD - item.recordedTWD);
            const canRecord = item.uid === myUid && canEdit && item.plannedTWD > 0 && remaining > 0;
            return (
              <li key={item.uid} className="flex flex-wrap items-center gap-2 text-sm">
                <MemberChip member={household.members[item.uid]} suffix={item.uid === myUid ? '（我）' : ''} className="min-w-0 text-sm" />
                <Badge variant={badge.variant} className="shrink-0">{badge.label}</Badge>
                <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                  <span className="font-semibold text-foreground" style={{ color: item.recordedTWD > 0 ? memberColor(household, item.uid) : undefined }}>
                    {formatCurrency(item.recordedTWD)}
                  </span>
                  {' / '}{formatCurrency(item.plannedTWD)}
                </span>
                {canRecord ? (
                  <Button size="sm" variant={item.state === 'due' ? 'default' : 'outline'} className="h-8 shrink-0" onClick={() => openRecord(remaining)}>
                    <PiggyBank className="size-4" /> 記錄存入
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>

        {status.expenses.length > 0 ? (
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground">固定從公基金扣款</h4>
            <ul className="divide-y rounded-lg border">
              {status.expenses.map((row) => {
                const badge = EXPENSE_BADGE[row.state];
                const category = catMap[row.item.categoryKey];
                const Icon = resolveIcon(category?.icon);
                const charging = charge.isPending && charge.variables?.item.id === row.item.id;
                const content = (
                  <>
                    <Icon className="size-4 shrink-0" style={{ color: category?.color }} />
                    <div className="min-w-0 flex-1">
                      <div className="break-words font-medium">{row.item.name || category?.name || '固定扣款'}</div>
                      <div className="text-xs text-muted-foreground">每月 {row.dueDay} 號 · {category?.name ?? row.item.categoryKey}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-semibold tabular-nums">{formatCurrency(row.tx ? row.tx.amountTWD : row.item.amountTWD)}</div>
                      <Badge variant={badge.variant} className="mt-0.5">{badge.label}</Badge>
                    </div>
                  </>
                );
                if (row.tx && !row.tx.deletedAt) {
                  const tx = row.tx;
                  return (
                    <li key={row.item.id}>
                      <button type="button" onClick={() => onOpenTx(tx)} className="flex w-full items-center gap-3 p-3 text-left text-sm hover:bg-muted/50">
                        {content}
                      </button>
                    </li>
                  );
                }
                return (
                  <li key={row.item.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                    {content}
                    {canEdit && row.item.enabled && status.active && (row.state === 'due' || row.state === 'upcoming') ? (
                      <Button
                        size="sm"
                        variant={row.state === 'due' ? 'default' : 'outline'}
                        className="h-8 w-full sm:w-auto"
                        disabled={charging}
                        onClick={() => charge.mutate({ household, item: row.item, monthKey: status.monthKey })}
                      >
                        {charging ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
                        {row.state === 'due' ? '立即扣款' : '提前扣款'}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <p className="text-[11px] text-muted-foreground">
              到日（台北 01:00）自動從公基金記一筆共同支出；已扣款的可點開修改金額或刪除，刪除後本月不會再自動補扣。
            </p>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <FlowStat label="每月存入" value={status.plannedInflowTWD} tone="good" />
          <FlowStat label="固定扣款" value={-status.fixedOutflowTWD} />
          <FlowStat label="其他支出（近 3 月平均）" value={-status.avgVariableOutflowTWD} />
          <FlowStat label="每月淨流入" value={status.netMonthlyTWD} tone={status.netMonthlyTWD < 0 ? 'bad' : 'good'} />
        </div>
        {status.runwayMonths !== null ? (
          <p className={cn('flex items-start gap-1.5 rounded-lg p-2 text-xs', status.runwayMonths < 3 ? 'bg-destructive/10 text-destructive' : 'bg-warning/10 text-warning')}>
            <CircleDashed className="mt-0.5 size-3.5 shrink-0" />
            每月支出大於存入，以目前餘額約可再撐 {status.runwayMonths.toFixed(1)} 個月，建議調高每月投入或減少固定扣款。
          </p>
        ) : status.plannedInflowTWD > 0 ? (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
            每月存入足以支應固定扣款與近期平均支出。
          </p>
        ) : null}
      </CardContent>

      <HouseholdFundPlanDialog household={household} open={planOpen} onOpenChange={setPlanOpen} />
      <HouseholdFundEntryDialog
        household={household}
        open={Boolean(preset)}
        onOpenChange={(next) => { if (!next) setPreset(null); }}
        preset={preset}
      />
    </Card>
  );
}

function FlowStat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/50 p-2">
      <div className="text-[11px] leading-tight text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 font-semibold tabular-nums', tone === 'good' && 'text-success', tone === 'bad' && 'text-destructive')}>
        {value > 0 && tone ? '+' : ''}{formatCurrency(value)}
      </div>
    </div>
  );
}
