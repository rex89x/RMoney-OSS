import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Calculator, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useFxRates } from '@/features/fx/hooks';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS, formatAxisTWD } from '@/lib/chart-theme';
import { dateInputToTWDate, formatDateInput, formatTW, startOfTWDay } from '@/lib/tz';
import { cn, formatCurrency } from '@/lib/utils';
import {
  AMORTIZATION_METHOD_LABEL, EARLY_REPAYMENT_MODE_LABEL, buildAmortizationSchedule, downsampleRows,
  remainingPrincipalAt, simulateEarlyRepayment, type AmortizationMethod, type EarlyRepaymentMode,
} from '../amortization';
import { currentDebtBalanceTWD } from '../valuation';
import type { Account } from '../types';

const PAGE_SIZE = 60;
const MAX_CHART_POINTS = 240;

interface AmortizationDialogProps {
  account: Account | null;
  onOpenChange: (open: boolean) => void;
}

type Basis = 'term' | 'payment';

/** 金額格式：攤還表算到分，顯示到元（利息很小時保留兩位） */
function money(value: number): string {
  return formatCurrency(Math.abs(value) < 100 ? Math.round(value * 100) / 100 : Math.round(value));
}

/** DatePicker 回傳瀏覽器本地午夜；轉成台北當天 00:00（pitfall #21） */
function toTWDay(d: Date): Date {
  return dateInputToTWDate(formatDateInput(d)) ?? startOfTWDay(d);
}

/** 攤還表輸入與計算（輸入預設帶貸款帳戶的設定，使用者可以改來試算） */
function useLoanAmortization(account: Account | null) {
  const { data: fxRates = [] } = useFxRates();
  const [principal, setPrincipal] = useState('');
  const [rate, setRate] = useState('');
  const [method, setMethod] = useState<AmortizationMethod>('annuity');
  const [basis, setBasis] = useState<Basis>('payment');
  const [termMonths, setTermMonths] = useState('');
  const [monthlyPayment, setMonthlyPayment] = useState('');
  const [startDate, setStartDate] = useState<Date>(() => startOfTWDay());
  const [extraAmount, setExtraAmount] = useState('');
  const [extraPeriod, setExtraPeriod] = useState('12');
  const [extraMode, setExtraMode] = useState<EarlyRepaymentMode>('shorten_term');

  useEffect(() => {
    if (!account) return;
    const loan = account.loan;
    const outstanding = currentDebtBalanceTWD(account, fxRates);
    setPrincipal(String(Math.round(outstanding > 0 ? outstanding : loan?.principalTWD ?? 0)));
    setRate(loan?.interestRate != null ? String(loan.interestRate) : '');
    setMethod('annuity');
    setTermMonths(loan?.termMonths ? String(loan.termMonths) : '');
    setMonthlyPayment(loan?.monthlyPayment ? String(loan.monthlyPayment) : '');
    // 有月付就用月付反推剩餘期數（餘額 + 月付最準），否則用期數
    setBasis(loan?.monthlyPayment && loan.monthlyPayment > 1 ? 'payment' : 'term');
    setStartDate(loan?.nextDueDate ?? startOfTWDay());
    setExtraAmount('');
    setExtraPeriod('12');
    setExtraMode('shorten_term');
    // 只在換帳戶時重設；fxRates 更新不覆蓋使用者正在試算的輸入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id]);

  const effectiveBasis: Basis = method === 'equal_principal' ? 'term' : basis;
  const input = useMemo(() => ({
    principal: Number(principal) || 0,
    annualRatePct: Number(rate) || 0,
    termMonths: effectiveBasis === 'term' ? Number(termMonths) || null : null,
    monthlyPayment: effectiveBasis === 'payment' ? Number(monthlyPayment) || null : null,
    startDate,
    method,
  }), [principal, rate, effectiveBasis, termMonths, monthlyPayment, startDate, method]);

  const schedule = useMemo(() => buildAmortizationSchedule(input), [input]);
  const remainingToday = useMemo(() => remainingPrincipalAt(schedule, new Date()), [schedule]);
  const chartData = useMemo(
    () => downsampleRows(schedule.rows, MAX_CHART_POINTS).map((r) => ({
      label: formatTW(r.date, 'yyyy/MM'),
      remaining: r.remaining,
    })),
    [schedule.rows],
  );
  const simulation = useMemo(() => {
    const amount = Number(extraAmount) || 0;
    if (amount <= 0 || schedule.error) return null;
    return simulateEarlyRepayment({ ...input, atPeriod: Number(extraPeriod) || 0, extraAmount: amount, mode: extraMode });
  }, [input, extraAmount, extraPeriod, extraMode, schedule.error]);

  return {
    form: {
      principal, setPrincipal, rate, setRate, method, setMethod, basis: effectiveBasis, setBasis,
      termMonths, setTermMonths, monthlyPayment, setMonthlyPayment, startDate, setStartDate,
      extraAmount, setExtraAmount, extraPeriod, setExtraPeriod, extraMode, setExtraMode,
    },
    schedule,
    remainingToday,
    chartData,
    simulation,
  };
}

export function AmortizationDialog({ account, onOpenChange }: AmortizationDialogProps) {
  const { form, schedule, remainingToday, chartData, simulation } = useLoanAmortization(account);
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(schedule.rows.length / PAGE_SIZE));
  useEffect(() => { setPage(0); }, [schedule]);
  const pageRows = schedule.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <ResponsiveDialog
      open={Boolean(account)}
      onOpenChange={onOpenChange}
      title={account ? `攤還表 — ${account.name}` : '攤還表'}
      description="以目前欠款為本金、下期繳款日為第 1 期試算；欄位都可以改。"
      contentClassName="sm:max-w-2xl"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="am-principal">本金（剩餘欠款）</Label>
            <Input id="am-principal" type="number" inputMode="decimal" value={form.principal} onChange={(e) => form.setPrincipal(e.target.value)} />
            {account?.loan?.principalTWD ? (
              <p className="mt-1 text-[11px] text-muted-foreground">原始本金 {money(account.loan.principalTWD)}</p>
            ) : null}
          </div>
          <div>
            <Label htmlFor="am-rate">年利率（%）</Label>
            <Input id="am-rate" type="number" inputMode="decimal" step="0.01" value={form.rate} onChange={(e) => form.setRate(e.target.value)} />
          </div>
          <div>
            <Label>攤還方式</Label>
            <Select value={form.method} onValueChange={(v) => form.setMethod(v as AmortizationMethod)}>
              <SelectTrigger className="mt-1 h-10"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(AMORTIZATION_METHOD_LABEL) as AmortizationMethod[]).map((m) => (
                  <SelectItem key={m} value={m}>{AMORTIZATION_METHOD_LABEL[m]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>依據</Label>
            <Select
              value={form.basis}
              onValueChange={(v) => form.setBasis(v as Basis)}
            >
              <SelectTrigger className="mt-1 h-10" disabled={form.method === 'equal_principal'}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="payment">每月還款金額</SelectItem>
                <SelectItem value="term">剩餘期數</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.basis === 'payment' ? (
            <div>
              <Label htmlFor="am-payment">每月還款</Label>
              <Input id="am-payment" type="number" inputMode="decimal" value={form.monthlyPayment} onChange={(e) => form.setMonthlyPayment(e.target.value)} />
            </div>
          ) : (
            <div>
              <Label htmlFor="am-term">剩餘期數（月）</Label>
              <Input id="am-term" type="number" inputMode="numeric" value={form.termMonths} onChange={(e) => form.setTermMonths(e.target.value)} />
            </div>
          )}
          <div>
            <Label>第 1 期繳款日</Label>
            <div className="mt-1">
              <DatePicker value={form.startDate} onChange={(d) => { if (d) form.setStartDate(toTWDay(d)); }} clearable={false} size="sm" />
            </div>
          </div>
        </div>

        {schedule.error ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{schedule.error}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Summary
                label={form.method === 'equal_principal' ? '首期 / 末期付款' : '每月付款'}
                value={form.method === 'equal_principal'
                  ? `${money(schedule.firstPayment)} / ${money(schedule.lastPayment)}`
                  : money(schedule.firstPayment)}
              />
              <Summary label="總利息" value={money(schedule.totalInterest)} />
              <Summary
                label="還清日"
                value={schedule.payoffDate ? formatTW(schedule.payoffDate, 'yyyy/MM') : '—'}
                hint={`共 ${schedule.termMonths} 期`}
              />
              <Summary label="今日剩餘本金" value={money(remainingToday)} />
            </div>

            <div className="h-[180px]" role="img" aria-label={`剩餘本金走勢，${schedule.termMonths} 期後還清`}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
                  <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={32} />
                  <YAxis {...AXIS_PROPS} width={48} tickFormatter={formatAxisTWD} />
                  <Tooltip
                    {...CHART_TOOLTIP_PROPS}
                    cursor={{ stroke: CHART_COLORS.grid }}
                    formatter={(value: number) => [money(value), '剩餘本金']}
                  />
                  <Line type="monotone" dataKey="remaining" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[480px] text-xs tabular-nums">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">期</th>
                    <th className="px-2 py-1.5 text-left font-medium">日期</th>
                    <th className="px-2 py-1.5 text-right font-medium">付款</th>
                    <th className="px-2 py-1.5 text-right font-medium">利息</th>
                    <th className="px-2 py-1.5 text-right font-medium">本金</th>
                    <th className="px-2 py-1.5 text-right font-medium">剩餘本金</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {pageRows.map((row) => (
                    <tr key={row.period}>
                      <td className="px-2 py-1">{row.period}</td>
                      <td className="px-2 py-1">{formatTW(row.date, 'yyyy/MM/dd')}</td>
                      <td className="px-2 py-1 text-right">{money(row.payment)}</td>
                      <td className="px-2 py-1 text-right text-muted-foreground">{money(row.interest)}</td>
                      <td className="px-2 py-1 text-right">{money(row.principal)}</td>
                      <td className="px-2 py-1 text-right">{money(row.remaining)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pageCount > 1 ? (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>第 {page * PAGE_SIZE + 1}–{Math.min(schedule.rows.length, (page + 1) * PAGE_SIZE)} 期 / 共 {schedule.rows.length} 期</span>
                <span className="flex gap-1">
                  <Button size="icon-sm" variant="outline" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} aria-label="上一頁">
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button size="icon-sm" variant="outline" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1} aria-label="下一頁">
                    <ChevronRight className="size-4" />
                  </Button>
                </span>
              </div>
            ) : null}

            <div className="space-y-3 rounded-lg border p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Calculator className="size-4" /> 提前還款試算
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div>
                  <Label htmlFor="am-extra">提前還本金額</Label>
                  <Input id="am-extra" type="number" inputMode="decimal" placeholder="例如 200000" value={form.extraAmount} onChange={(e) => form.setExtraAmount(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="am-extra-period">在第幾期繳完後</Label>
                  <Input id="am-extra-period" type="number" inputMode="numeric" value={form.extraPeriod} onChange={(e) => form.setExtraPeriod(e.target.value)} />
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <Label>還款後</Label>
                  <Select value={form.extraMode} onValueChange={(v) => form.setExtraMode(v as EarlyRepaymentMode)}>
                    <SelectTrigger className="mt-1 h-10"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(EARLY_REPAYMENT_MODE_LABEL) as EarlyRepaymentMode[]).map((m) => (
                        <SelectItem key={m} value={m}>{EARLY_REPAYMENT_MODE_LABEL[m]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {simulation ? (
                simulation.error ? (
                  <p className="text-xs text-destructive">{simulation.error}</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Summary label="省下利息" value={money(simulation.interestSaved)} accent />
                    <Summary
                      label="新還清日"
                      value={simulation.after.payoffDate ? formatTW(simulation.after.payoffDate, 'yyyy/MM') : '—'}
                      hint={simulation.monthsSaved > 0 ? `提早 ${simulation.monthsSaved} 期` : '期數不變'}
                    />
                    <Summary label="之後每期付款" value={money(simulation.newPayment)} />
                    <Summary label="新總利息" value={money(simulation.after.totalInterest)} />
                  </div>
                )
              ) : (
                <p className="text-xs text-muted-foreground">輸入金額即可比較縮短期數與降低月付的差別。實際條件（違約金、最低還款額）以銀行為準。</p>
              )}
            </div>
          </>
        )}
      </div>
    </ResponsiveDialog>
  );
}

interface SummaryProps {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}

function Summary({ label, value, hint, accent }: SummaryProps) {
  return (
    <div className="rounded-lg border p-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-sm font-semibold tabular-nums', accent && 'text-emerald-600 dark:text-emerald-400')}>{value}</div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
