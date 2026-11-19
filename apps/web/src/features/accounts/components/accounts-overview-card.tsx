import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Banknote, Building2, CalendarClock, CreditCard, Home, Landmark, ShieldCheck, TrendingUp, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAllBills } from '@/features/billing/hooks';
import { effectiveDueDate } from '@/features/billing/types';
import { useRentals } from '@/features/rentals';
import {
  totalProjectedRecoverableTWD,
  totalProjectedRemainingRecoverableTWD,
  totalUnrecoveredCostTWD,
} from '@/features/rentals/types';
import { usePortfolio, useStocks } from '@/features/investments/hooks';
import { useFxRates } from '@/features/fx/hooks';
import { formatTW, startOfTWDay } from '@/lib/tz';
import { listCashAccounts } from '@/features/net-worth/api';
import { unreconciledLegacyCashAccounts } from '@/features/net-worth/legacy-cash';
import { useAccounts } from '../hooks';
import { currencyToTwdRate, currentAccountBalanceTWD, currentDebtBalanceTWD, longTermAccountValueTWD } from '../valuation';
import type { Account, AccountType } from '../types';
import type { FxRate } from '@/features/fx/types';

interface AccountGroup {
  label: string;
  amount: number;
  /** 帳戶原始加總（可能 < 0，被吸收前的值，給 tooltip / debug 用） */
  rawAmount: number;
  count: number;
  icon: typeof Wallet;
  tone: 'asset' | 'debt';
}

const LIQUID_GROUP_KEYS = ['cash_bank', 'e_wallet', 'investment_cash'] as const;

function groupAccounts(accounts: Account[], fxRates: FxRate[]): AccountGroup[] {
  const groups: Record<string, AccountGroup> = {
    cash_bank: { label: '現金 / 銀行', amount: 0, rawAmount: 0, count: 0, icon: Landmark, tone: 'asset' },
    e_wallet: { label: '電子錢包', amount: 0, rawAmount: 0, count: 0, icon: Wallet, tone: 'asset' },
    investment_cash: { label: '交割帳戶', amount: 0, rawAmount: 0, count: 0, icon: Building2, tone: 'asset' },
    insurance_pension: { label: '保險解約金 / 退休', amount: 0, rawAmount: 0, count: 0, icon: ShieldCheck, tone: 'asset' },
    credit_card: { label: '信用卡待繳', amount: 0, rawAmount: 0, count: 0, icon: CreditCard, tone: 'debt' },
    loan: { label: '貸款剩餘', amount: 0, rawAmount: 0, count: 0, icon: Banknote, tone: 'debt' },
  };
  for (const account of accounts) {
    const target = ((): keyof typeof groups | null => {
      switch (account.type) {
        case 'cash':
        case 'bank':
          return 'cash_bank';
        case 'e_wallet_balance':
          return 'e_wallet';
        case 'investment_cash':
          return 'investment_cash';
        case 'credit_card':
          return 'credit_card';
        case 'loan':
          return 'loan';
        case 'insurance':
        case 'pension':
          return 'insurance_pension';
        default:
          return null;
      }
    })();
    if (!target) continue;
    const slot = groups[target];
    if (!slot) continue;
    // 保單只計解約金、退休帳戶以餘額計（與 useNetWorthNow 同口徑）
    const value = account.type === 'credit_card' || account.type === 'loan'
      ? currentDebtBalanceTWD(account, fxRates)
      : target === 'insurance_pension'
        ? longTermAccountValueTWD(account, fxRates)
        : currentAccountBalanceTWD(account, fxRates);
    slot.amount += value;
    slot.rawAmount += value;
    slot.count += 1;
  }
  return Object.values(groups).filter((g) => g.count > 0);
}

/**
 * 把租賃未回收成本「吸收」到流動資產組的負值，避免「現金 -800K」這種視覺。
 * 邏輯與 useNetWorthNow 相同：先看流動組裡 < 0 的部分，從 rentalUnrecovered 補。
 * Return: 補完之後剩下多少 rentalUnrecovered，用來放到「租賃資產」群組。
 */
function absorbNegativeLiquid(groups: AccountGroup[], rentalUnrecovered: number): number {
  let remaining = rentalUnrecovered;
  if (remaining <= 0) return 0;
  for (const key of LIQUID_GROUP_KEYS) {
    const slot = groups.find((g) => g.label === groupLabelByKey(key));
    if (!slot || slot.amount >= 0) continue;
    const need = -slot.amount;
    const take = Math.min(remaining, need);
    slot.amount += take;
    remaining -= take;
    if (remaining <= 0) return 0;
  }
  return remaining;
}

function groupLabelByKey(key: typeof LIQUID_GROUP_KEYS[number]): string {
  switch (key) {
    case 'cash_bank': return '現金 / 銀行';
    case 'e_wallet': return '電子錢包';
    case 'investment_cash': return '交割帳戶';
  }
}

interface UpcomingPayment {
  label: string;
  dueDate: Date;
  amount: number;
  kind: 'credit_card' | 'loan';
}

export function AccountsOverviewCard() {
  const { data: accounts = [], isLoading } = useAccounts();
  const { data: legacyCashAccounts = [] } = useQuery({
    queryKey: ['cash-accounts'],
    queryFn: listCashAccounts,
    staleTime: 60 * 1000,
  });
  const { data: bills = [] } = useAllBills();
  const { data: rentals = [] } = useRentals();
  const { data: positions = [] } = usePortfolio();
  const { data: stocks = [] } = useStocks();
  const { data: fxRates = [] } = useFxRates();
  const today = startOfTWDay();

  const rentalUnrecovered = useMemo(() => totalUnrecoveredCostTWD(rentals), [rentals]);
  const rentalActiveCount = useMemo(
    () => rentals.filter((r) => r.status === 'active' && r.purchaseAmountTWD > 0).length,
    [rentals],
  );
  const rentalProjection = useMemo(() => ({
    totalRecoverable: totalProjectedRecoverableTWD(rentals),
    remainingRecoverable: totalProjectedRemainingRecoverableTWD(rentals),
  }), [rentals]);
  const investmentMarketValue = useMemo(() => {
    const stockMap = new Map(stocks.map((stock) => [stock.symbol, stock]));
    return positions.reduce((sum, position) => {
      const stock = stockMap.get(position.symbol);
      const currentPrice = stock?.currentPrice && stock.currentPrice > 0 ? stock.currentPrice : position.avgCost;
      const nativeValue = currentPrice * position.shares;
      return sum + nativeValue * currencyToTwdRate(position.currency, fxRates);
    }, 0);
  }, [positions, stocks, fxRates]);

  const groups = useMemo<AccountGroup[]>(() => {
    const liquidGroups = groupAccounts(accounts, fxRates);
    const legacyCash = unreconciledLegacyCashAccounts(legacyCashAccounts, accounts);
    const legacyCashTotal = legacyCash.reduce((sum, account) => sum + (account.amountTWD || account.amount || 0), 0);
    const cashBank = liquidGroups.find((group) => group.label === '現金 / 銀行');
    if (legacyCashTotal > 0 && cashBank) {
      cashBank.amount += legacyCashTotal;
      cashBank.rawAmount += legacyCashTotal;
      cashBank.count += legacyCash.length;
    } else if (legacyCashTotal > 0) {
      liquidGroups.unshift({
        label: '現金 / 銀行',
        amount: legacyCashTotal,
        rawAmount: legacyCashTotal,
        count: legacyCash.length,
        icon: Landmark,
        tone: 'asset',
      });
    }
    // 把 rentalUnrecovered 用來吸收流動資產的負值（避免「現金 -X」視覺）
    const residualRental = absorbNegativeLiquid(liquidGroups, rentalUnrecovered);
    const out = [...liquidGroups];
    if (investmentMarketValue > 0) {
      out.push({
        label: '投資市值',
        amount: investmentMarketValue,
        rawAmount: investmentMarketValue,
        count: positions.length,
        icon: TrendingUp,
        tone: 'asset',
      });
    }
    if (residualRental > 0) {
      out.push({
        label: '租賃資產（未回收成本）',
        amount: residualRental,
        rawAmount: rentalUnrecovered,
        count: rentalActiveCount,
        icon: Home,
        tone: 'asset',
      });
    }
    return out;
  }, [accounts, legacyCashAccounts, fxRates, investmentMarketValue, positions.length, rentalUnrecovered, rentalActiveCount]);

  const totals = useMemo(() => {
    let assets = 0;
    let debts = 0;
    for (const group of groups) {
      if (group.tone === 'asset') assets += group.amount;
      else debts += group.amount;
    }
    return { assets, debts, net: assets - debts };
  }, [groups]);

  const upcoming = useMemo<UpcomingPayment[]>(() => {
    const rows: UpcomingPayment[] = [];
    const horizon = today.getTime() + 14 * 86400000;

    for (const account of accounts) {
      if (!account.active) continue;
      if (account.type === 'loan' && account.loan) {
        const due = account.loan.nextDueDate;
        if (due.getTime() <= horizon) {
          rows.push({
            label: account.name,
            dueDate: due,
            amount: account.loan.monthlyPayment,
            kind: 'loan',
          });
        }
      }
    }

    for (const bill of bills) {
      if (bill.paidAt) continue;
      const eff = effectiveDueDate(bill);
      if (eff.getTime() <= horizon) {
        const account = accounts.find((row) => row.id === bill.accountId);
        rows.push({
          label: account?.name ?? bill.paymentMethodId,
          dueDate: eff,
          amount: bill.amount ?? 0,
          kind: 'credit_card',
        });
      }
    }

    return rows.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime()).slice(0, 5);
  }, [accounts, bills, today]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="size-4" /> 資產總覽
        </CardTitle>
        <Link to="/settings#accounts" className="text-xs text-muted-foreground hover:text-foreground">
          管理帳戶
        </Link>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中…</p>
        ) : accounts.length === 0 && positions.length === 0 && rentals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            尚未建立帳戶或資產資料。到「設定 → 帳戶」新增現金、銀行、信用卡或貸款，或到「投資 / 租賃」建立資產。
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 rounded-lg border p-3 md:grid-cols-4">
              <Stat label="目前資產" amount={totals.assets} tone="asset" />
              <Stat label="目前負債" amount={totals.debts} tone="debt" />
              <Stat
                label="目前淨額"
                amount={totals.net}
                tone={totals.net >= 0 ? 'asset' : 'debt'}
                highlight
              />
              <Stat
                label="預估未來回收"
                amount={rentalProjection.remainingRecoverable}
                tone="asset"
              />
            </div>
            <p className="-mt-2 text-[10px] text-muted-foreground">
              目前淨額含帳戶餘額、投資市值與租賃未回收成本；預估未來回收是租賃案件剩餘現金流，不列入目前淨額。
              {rentalProjection.totalRecoverable > 0 ? ` 全期預估總回收 NT$${Math.round(rentalProjection.totalRecoverable).toLocaleString()}。` : ''}
            </p>

            <ul className="divide-y rounded-md border">
              {groups.map((group) => {
                const Icon = group.icon;
                const absorbed = group.tone === 'asset' && group.amount !== group.rawAmount
                  ? group.amount - group.rawAmount
                  : 0;
                return (
                  <li key={group.label} className="flex items-center gap-3 p-3 text-sm">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{group.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {group.count} 個帳戶
                        {absorbed > 0 ? `（含 NT$${Math.round(absorbed).toLocaleString()} 租賃購入抵銷）` : null}
                      </div>
                    </div>
                    <div className={`text-sm font-medium tabular-nums ${group.tone === 'debt' ? 'text-destructive' : ''}`}>
                      {group.tone === 'debt' ? '−' : ''}NT${Math.round(group.amount).toLocaleString()}
                    </div>
                  </li>
                );
              })}
            </ul>

            {upcoming.length > 0 ? (
              <div>
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <CalendarClock className="size-3" />
                  即將到期（14 天內）
                </div>
                <ul className="space-y-1.5">
                  {upcoming.map((item, idx) => {
                    const days = Math.round((item.dueDate.getTime() - today.getTime()) / 86400000);
                    return (
                      <li key={`${item.label}-${idx}`} className="flex items-center gap-2 text-sm">
                        <Badge
                          variant={days < 0 ? 'destructive' : days <= 3 ? 'destructive' : 'outline'}
                          className="shrink-0"
                        >
                          {days < 0 ? `逾期 ${Math.abs(days)} 天` : days === 0 ? '今日' : `${days} 天`}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate">
                          {item.kind === 'credit_card' ? '信用卡' : '貸款'} · {item.label}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatTW(item.dueDate, 'MM/dd')}
                          {item.amount > 0 ? ` · NT$${Math.round(item.amount).toLocaleString()}` : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label, amount, tone, highlight,
}: { label: string; amount: number; tone: 'asset' | 'debt'; highlight?: boolean }) {
  const tint = tone === 'debt' ? 'text-destructive' : 'text-foreground';
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-0.5 tabular-nums ${highlight ? 'text-lg font-semibold' : 'text-base font-medium'} ${tint}`}>
        {tone === 'debt' && amount > 0 ? '−' : ''}NT${Math.round(amount).toLocaleString()}
      </div>
    </div>
  );
}

export type { AccountGroup, AccountType };
