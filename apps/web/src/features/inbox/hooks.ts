import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { optimisticUpdate } from '@/lib/optimistic';
import { useAuth } from '@/hooks/use-auth';
import { useBudget, useCategories, useTransactions } from '@/features/ledger/hooks';
import { useMyExpenseShare } from '@/features/ledger/use-my-share';
import { usePaymentMethods } from '@/features/ledger/payment-methods';
import { effectiveAmountTWD, loanDeltaTWD } from '@/features/ledger/types';
import { PAYOUT_GROUP_CATEGORY } from '@/features/payouts/types';
import { usePayoutGroups } from '@/features/payouts/hooks';
import { useActiveHousehold, useHouseholdBalance, useHouseholdMonthSummary } from '@/features/household/hooks';
import { useDetectedSubscriptions, useSubscriptions } from '@/features/subscriptions/hooks';
import { useScheduledPayments } from '@/features/scheduled-payments/hooks';
import { useAllBills, buildCycleView, type CreditCardBill } from '@/features/billing';
import { useAccounts } from '@/features/accounts/hooks';
import { insuranceReminders } from '@/features/accounts/insurance';
import { addTWCalendarMonths, daysBetweenTWDates, formatTW, formatTWMonthKey, monthTWRange, nowTW, startOfTWDay } from '@/lib/tz';
import { formatCurrency } from '@/lib/utils';
import { addInboxTodos, dismissInboxItem, getInboxDismissed, getInboxTodos, removeInboxTodo, safeInboxId, undismissInboxItem } from './api';
import type { InboxDismissedMap, InboxItem, InboxTodo } from './types';
import { isConsumptionExpense } from '@/features/analytics/metrics';
import { requireUid } from '@/lib/assert';

/** 交易類 item 只看最近 N 天（更早的通常已經不想整理了） */
const TX_LOOKBACK_DAYS = 45;
/** 信用卡到期 N 天內就進 inbox */
const CC_DUE_AHEAD_DAYS = 5;
/** 代墊超過 N 天未結清才提醒（剛發生的還不用催） */
const LOAN_MIN_AGE_DAYS = 7;
/** 共同帳未結算餘額達此金額才進 inbox */
const HOUSEHOLD_SETTLE_MIN_TWD = 1000;

const UNCATEGORIZED_KEYS = new Set(['other', 'other_income', 'uncategorized', 'misc']);

export function useInboxDismissed() {
  const { user } = useAuth();
  return useQuery<InboxDismissedMap>({
    queryKey: ['inbox-dismissed', user?.uid],
    queryFn: () => getInboxDismissed(requireUid(user)),
    enabled: Boolean(user?.uid),
    staleTime: 5 * 60 * 1000,
  });
}

export function useDismissInboxItem() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: ({ id, undo }: { id: string; undo?: boolean }) => {
      if (!user) throw new Error('Not logged in');
      return undo ? undismissInboxItem(user.uid, id) : dismissInboxItem(user.uid, id);
    },
    // 樂觀更新：略過的項目立刻消失，失敗再出現
    onMutate: async ({ id, undo }) => {
      const rollback = await optimisticUpdate<InboxDismissedMap>(qc, ['inbox-dismissed'], (map) => {
        const next = { ...map };
        if (undo) delete next[id];
        else next[id] = new Date().toISOString();
        return next;
      });
      return { rollback };
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['inbox-dismissed'] }),
    onError: (err, _vars, ctx) => {
      ctx?.rollback();
      console.error('[dismissInboxItem]', err);
      toast.error(err instanceof Error ? err.message : '略過失敗');
    },
  });
}

export function useInboxTodos() {
  const { user } = useAuth();
  return useQuery<InboxTodo[]>({
    queryKey: ['inbox-todos', user?.uid],
    queryFn: () => getInboxTodos(requireUid(user)),
    enabled: Boolean(user?.uid),
    staleTime: 60 * 1000,
  });
}

export function useAddInboxTodos() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (todos: Omit<InboxTodo, 'id' | 'createdAt'>[]) => {
      if (!user) throw new Error('Not logged in');
      return addInboxTodos(user.uid, todos);
    },
    onSuccess: (rows) => {
      void qc.invalidateQueries({ queryKey: ['inbox-todos'] });
      if (rows.length) toast.success(`已加入 ${rows.length} 項待辦`);
    },
    onError: (err) => {
      console.error('[addInboxTodos]', err);
      toast.error(err instanceof Error ? err.message : '新增待辦失敗');
    },
  });
}

export function useCompleteInboxTodo() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (todo: InboxTodo) => {
      if (!user) throw new Error('Not logged in');
      return removeInboxTodo(user.uid, todo);
    },
    onMutate: async (todo: InboxTodo) => {
      const rollback = await optimisticUpdate<InboxTodo[]>(qc, ['inbox-todos'], (rows) => rows.filter((t) => t.id !== todo.id));
      return { rollback };
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['inbox-todos'] }),
    onError: (err, _todo, ctx) => {
      ctx?.rollback();
      console.error('[completeInboxTodo]', err);
      toast.error(err instanceof Error ? err.message : '更新待辦失敗');
    },
  });
}

interface InboxResult {
  items: InboxItem[];
  /** 含已略過的全部 */
  all: InboxItem[];
  dismissed: InboxDismissedMap;
  isLoading: boolean;
}

export function useInboxItems(): InboxResult {
  const tw = useMemo(() => nowTW(), []);
  const monthKey = formatTWMonthKey(tw);
  const lookbackStart = useMemo(
    () => startOfTWDay(new Date(Date.now() - TX_LOOKBACK_DAYS * 86400000)),
    [],
  );
  const loanStart = useMemo(() => startOfTWDay(addTWCalendarMonths(new Date(), -12)), []);

  const { data: recentTxs = [], isLoading: txLoading } = useTransactions({ startDate: lookbackStart, limit: 1000 });
  const { data: yearTxs = [] } = useTransactions({ startDate: loanStart, limit: 2000 });
  const { data: categories = [] } = useCategories();
  const { data: budget } = useBudget(monthKey);
  const { data: payoutGroups = [] } = usePayoutGroups();
  const { data: subs = [] } = useSubscriptions();
  const detected = useDetectedSubscriptions(6);
  const { data: scheduled = [] } = useScheduledPayments();
  const { data: methods = [] } = usePaymentMethods();
  const { data: bills = [] } = useAllBills();
  const { data: accounts = [] } = useAccounts();
  const { data: dismissed = {}, isLoading: dismissedLoading } = useInboxDismissed();
  const { data: todos = [] } = useInboxTodos();
  const myShare = useMyExpenseShare();
  const { user } = useAuth();
  const household = useActiveHousehold();
  const { debts: householdDebts } = useHouseholdBalance(household);
  const { summary: householdMonth } = useHouseholdMonthSummary(household);

  const all = useMemo<InboxItem[]>(() => {
    const items: InboxItem[] = [];
    const today0 = startOfTWDay();
    const catByKey = new Map(categories.map((c) => [c.key, c]));

    // 0. 手動待辦
    for (const t of todos) {
      const age = daysBetweenTWDates(t.createdAt, today0);
      items.push({
        id: safeInboxId(`todo:${t.id}`),
        kind: 'manual',
        severity: 'info',
        title: t.title,
        detail: t.detail ?? (age > 0 ? `${age} 天前加入` : '今天加入'),
        sortKey: -age,
        href: t.href ?? undefined,
        payload: { todo: t },
      });
    }

    // 1. 待整理交易：類別是「其他」或類別已不存在
    for (const t of recentTxs) {
      if (t.deletedAt || t.type === 'transfer') continue;
      const missing = !catByKey.has(t.category);
      const other = UNCATEGORIZED_KEYS.has(t.category);
      if (!missing && !other) continue;
      items.push({
        id: safeInboxId(`tx:${t.id}`),
        kind: 'uncategorized-tx',
        severity: 'info',
        title: t.note?.trim() || (missing ? `類別「${t.category}」已不存在` : '未分類支出'),
        detail: `${formatTW(t.date, 'MM/dd')} · ${t.paymentMethod}${missing ? '' : ' · 類別：其他'}`,
        amountTWD: effectiveAmountTWD(t),
        sortKey: daysBetweenTWDates(t.date, today0),
        tx: t,
      });
    }

    // 2. 未結清代墊（依對方彙總）
    const loanAgg = new Map<string, { net: number; count: number; oldest: Date }>();
    for (const t of yearTxs) {
      if (t.deletedAt) continue;
      if (!t.splitMode || t.splitMode === 'self' || !t.counterpartyName) continue;
      if (t.loanSettledAt || t.category === PAYOUT_GROUP_CATEGORY || t.householdId) continue;
      const delta = loanDeltaTWD(t);
      if (delta === 0) continue;
      const cur = loanAgg.get(t.counterpartyName) ?? { net: 0, count: 0, oldest: t.date };
      cur.net += delta;
      cur.count += 1;
      if (t.date < cur.oldest) cur.oldest = t.date;
      loanAgg.set(t.counterpartyName, cur);
    }
    loanAgg.forEach((agg, name) => {
      const age = daysBetweenTWDates(agg.oldest, today0);
      if (age < LOAN_MIN_AGE_DAYS || Math.round(agg.net) === 0) return;
      const theyOwe = agg.net > 0;
      items.push({
        id: safeInboxId(`loan:${name}`),
        kind: 'unsettled-loan',
        severity: age > 30 ? 'warn' : 'info',
        title: theyOwe ? `${name} 還欠你` : `你還欠 ${name}`,
        detail: `${agg.count} 筆未結清 · 最早 ${formatTW(agg.oldest, 'MM/dd')}（${age} 天前）`,
        amountTWD: Math.abs(agg.net),
        sortKey: -age,
        href: '/ledger?tab=loans',
      });
    });

    // 3. 墊付團未收齊
    for (const g of payoutGroups) {
      if (g.archivedAt) continue;
      const unpaid = g.participants.filter((p) => !p.paidAt && p.amountTWD > 0);
      if (unpaid.length === 0) continue;
      const total = unpaid.reduce((s, p) => s + p.amountTWD, 0);
      const age = daysBetweenTWDates(g.date, today0);
      items.push({
        id: safeInboxId(`payout:${g.id}`),
        kind: 'payout-unpaid',
        severity: age > 14 ? 'warn' : 'info',
        title: g.title,
        detail: `${unpaid.length} 人未繳：${unpaid.map((p) => p.name).join('、')}`,
        amountTWD: total,
        sortKey: -age,
        href: '/ledger?tab=loans',
      });
    }

    // 4. 疑似訂閱（偵測到但還沒建立）
    const knownSubs = new Set(subs.map((s) => s.name.toLowerCase().trim()));
    for (const d of detected) {
      if (knownSubs.has(d.displayName.toLowerCase().trim()) || knownSubs.has(d.noteKey)) continue;
      items.push({
        id: safeInboxId(`sub:${d.noteKey}`),
        kind: 'subscription-candidate',
        severity: 'info',
        title: d.displayName,
        detail: `${d.occurrences} 次規律扣款 · 最近 ${d.daysSinceLast} 天前`,
        amountTWD: d.amountTWD,
        sortKey: d.daysSinceLast,
        href: '/settings?tab=subscriptions',
        payload: { detected: d },
      });
    }

    // 5. 信用卡帳單到期
    const billsByKey = new Map<string, CreditCardBill>();
    for (const b of bills) billsByKey.set(`${b.paymentMethodId}__${b.cycleMonth}`, b);
    for (const pm of methods) {
      const view = buildCycleView(pm, billsByKey);
      if (!view || view.status === 'paid') continue;
      if (view.daysToDue > CC_DUE_AHEAD_DAYS) continue;
      const overdue = view.daysToDue < 0;
      items.push({
        id: safeInboxId(`ccdue:${pm.id}__${view.cycleMonth}`),
        kind: 'credit-card-due',
        severity: overdue || view.daysToDue === 0 ? 'urgent' : 'warn',
        title: pm.name,
        detail: overdue
          ? `已逾期 ${-view.daysToDue} 天（${formatTW(view.effectiveDue, 'MM/dd')}）`
          : view.daysToDue === 0
            ? '今天是繳款截止日'
            : `${view.daysToDue} 天後到期（${formatTW(view.effectiveDue, 'MM/dd')}）`,
        amountTWD: view.bill?.amount ?? undefined,
        sortKey: view.daysToDue,
        href: '/settings?tab=bills',
      });
    }

    // 6. 排程支出到期（依 remindBeforeDays）
    for (const p of scheduled) {
      if (p.recurrence === 'one-time' && p.paidAt) continue;
      const days = daysBetweenTWDates(today0, p.dueDate);
      if (days > p.remindBeforeDays) continue;
      items.push({
        id: safeInboxId(`sched:${p.id}__${formatTW(p.dueDate, 'yyyyMMdd')}`),
        kind: 'scheduled-payment-due',
        severity: days <= 0 ? 'urgent' : 'warn',
        title: p.name,
        detail: days < 0 ? `已逾期 ${-days} 天` : days === 0 ? '今天到期' : `${days} 天後到期（${formatTW(p.dueDate, 'MM/dd')}）`,
        amountTWD: p.amountTWD,
        sortKey: days,
        href: '/settings?tab=scheduled',
        payload: { scheduledId: p.id },
      });
    }

    // 6b. 保單：保費 14 天內 / 已逾期、滿期 30 天內（規則在 accounts/insurance.ts，與 GAS notifyInsuranceDue 同步）
    for (const r of insuranceReminders(accounts, today0)) {
      const dateText = formatTW(r.date, 'MM/dd');
      if (r.kind === 'premium') {
        items.push({
          id: safeInboxId(`ins-premium:${r.accountId}__${formatTW(r.date, 'yyyyMMdd')}`),
          kind: 'insurance',
          severity: r.days <= 0 ? 'urgent' : r.days <= 3 ? 'warn' : 'info',
          title: `${r.accountName} 保費`,
          detail: r.days < 0 ? `已逾期 ${-r.days} 天（${dateText}）` : r.days === 0 ? '今天到期' : `${r.days} 天後到期（${dateText}）`,
          amountTWD: r.premiumTWD,
          sortKey: r.days,
          href: '/settings?tab=accounts',
        });
      } else {
        items.push({
          id: safeInboxId(`ins-maturity:${r.accountId}__${formatTW(r.date, 'yyyyMMdd')}`),
          kind: 'insurance',
          severity: r.days <= 7 ? 'warn' : 'info',
          title: `${r.accountName} 即將滿期`,
          detail: r.days === 0 ? '今天滿期' : `${r.days} 天後滿期（${dateText}）· 記得確認滿期金 / 續保`,
          sortKey: r.days,
          href: '/settings?tab=accounts',
        });
      }
    }

    // 7. 預算警示（本月 ≥ 80%）
    if (budget) {
      const { start, end } = monthTWRange(tw.getFullYear(), tw.getMonth() + 1);
      const monthExp = recentTxs.filter(
        (t) => isConsumptionExpense(t) && t.date >= start && t.date <= end,
      );
      const byCat = new Map<string, number>();
      let total = 0;
      for (const t of monthExp) {
        const v = myShare(t);
        total += v;
        byCat.set(t.category, (byCat.get(t.category) ?? 0) + v);
      }
      const pushBudget = (key: string, label: string, spent: number, limit: number) => {
        if (limit <= 0) return;
        const pct = spent / limit;
        if (pct < 0.8) return;
        items.push({
          id: safeInboxId(`budget:${monthKey}:${key}`),
          kind: 'budget-warn',
          severity: pct >= 1 ? 'urgent' : 'warn',
          title: label,
          detail: `已用 ${Math.round(pct * 100)}%（${formatCurrency(spent)} / ${formatCurrency(limit)}）`,
          sortKey: -pct,
          href: '/settings?tab=budget',
        });
      };
      pushBudget('__total', '本月總預算', total, budget.total);
      for (const [key, limit] of Object.entries(budget.byCategory ?? {})) {
        pushBudget(key, catByKey.get(key)?.name ?? key, byCat.get(key) ?? 0, limit);
      }
    }

    // 8. 共同帳：未結算餘額 ≥ 1,000、共同預算 ≥ 80%
    if (household) {
      const debt = householdDebts[0];
      if (debt && debt.amountTWD >= HOUSEHOLD_SETTLE_MIN_TWD) {
        const meOwed = debt.toUid === user?.uid;
        const other = household.members[meOwed ? debt.fromUid : debt.toUid]?.displayName ?? '對方';
        items.push({
          id: safeInboxId(`household:settle:${monthKey}`),
          kind: 'household',
          severity: 'info',
          title: meOwed ? `${other} 還要付你` : `你還要付 ${other}`,
          detail: `${household.name} 未結算餘額`,
          amountTWD: debt.amountTWD,
          sortKey: -debt.amountTWD / 1000,
          href: '/shared',
        });
      }
      const hb = household.monthlyBudgetTWD ?? 0;
      if (hb > 0 && householdMonth.totalTWD / hb >= 0.8) {
        const pct = householdMonth.totalTWD / hb;
        items.push({
          id: safeInboxId(`household:budget:${monthKey}`),
          kind: 'household',
          severity: pct >= 1 ? 'urgent' : 'warn',
          title: `${household.name} 本月預算`,
          detail: `已用 ${Math.round(pct * 100)}%（${formatCurrency(householdMonth.totalTWD)} / ${formatCurrency(hb)}）`,
          sortKey: -pct,
          href: '/shared',
        });
      }
    }

    const sevRank = { urgent: 0, warn: 1, info: 2 } as const;
    items.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.sortKey - b.sortKey);
    return items;
  }, [recentTxs, yearTxs, categories, budget, payoutGroups, subs, detected, scheduled, methods, bills, accounts, myShare, monthKey, tw, todos, household, householdDebts, householdMonth, user?.uid]);

  const items = useMemo(() => all.filter((i) => !dismissed[i.id]), [all, dismissed]);

  return { items, all, dismissed, isLoading: txLoading || dismissedLoading };
}

