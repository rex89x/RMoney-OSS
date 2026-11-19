import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLatestSnapshot } from '@/features/investments/hooks';
import { useAllBills } from '@/features/billing/hooks';
import { effectiveDueDate } from '@/features/billing/types';
import { currentAccountBalanceTWD, currentDebtBalanceTWD, totalInsurancePensionTWD, useAccounts } from '@/features/accounts';
import { useFxRates } from '@/features/fx/hooks';
import { useRentals } from '@/features/rentals';
import { totalUnrecoveredCostTWD } from '@/features/rentals/types';
import { useInstallmentPlans } from '@/features/installments/hooks';
import { totalInstallmentRemainingTWD } from '@/features/installments/schedule';
import { callAppsScript } from '@/lib/apps-script';
import { startOfTWDay } from '@/lib/tz';
import { totalLiquidTWD, unreconciledLegacyCashAccounts } from './legacy-cash';
import {
  archiveCashAccount, deleteLiability, deleteManualAsset, listCashAccounts,
  listLiabilities, listManualAssets, listNetWorthSnapshots, upsertCashAccount,
  upsertLiability, upsertManualAsset, upsertNetWorthSnapshot,
} from './api';
import type { NetWorthSnapshot } from './types';

export function useCashAccounts() {
  return useQuery({ queryKey: ['cash-accounts'], queryFn: listCashAccounts, staleTime: 60 * 1000 });
}

export function useUpsertCashAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input, id }: { input: Parameters<typeof upsertCashAccount>[0]; id?: string }) =>
      upsertCashAccount(input, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['cash-accounts'] }),
  });
}

export function useArchiveCashAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: archiveCashAccount,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['cash-accounts'] }),
  });
}

export function useManualAssets() {
  return useQuery({ queryKey: ['manual-assets'], queryFn: listManualAssets, staleTime: 60 * 1000 });
}

export function useUpsertManualAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input, id }: { input: Parameters<typeof upsertManualAsset>[0]; id?: string }) =>
      upsertManualAsset(input, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['manual-assets'] }),
  });
}

export function useDeleteManualAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteManualAsset,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['manual-assets'] }),
  });
}

export function useLiabilities() {
  return useQuery({ queryKey: ['liabilities'], queryFn: listLiabilities, staleTime: 60 * 1000 });
}

export function useUpsertLiability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input, id }: { input: Parameters<typeof upsertLiability>[0]; id?: string }) =>
      upsertLiability(input, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['liabilities'] }),
  });
}

export function useDeleteLiability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteLiability,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['liabilities'] }),
  });
}

export function useNetWorthSnapshots(months = 24) {
  return useQuery({
    queryKey: ['net-worth-snapshots', months],
    queryFn: () => listNetWorthSnapshots(months),
    staleTime: 5 * 60 * 1000,
  });
}

export function useUpsertNetWorthSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: upsertNetWorthSnapshot,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['net-worth-snapshots'] }),
  });
}

/**
 * 觸發 Apps Script 重新計算當月 net worth snapshot。
 * 寫入用 Apps Script，邏輯與排程一致（CLAUDE.md §17.1：手動 / 排程算出來的值要一致）。
 * 失敗時 fallback 用前端 useNetWorthNow + upsert 直寫 Firestore。
 */
export function useTriggerNetWorthSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callAppsScript('snapshotNetWorth'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['net-worth-snapshots'] }),
  });
}

/**
 * 即時計算當下淨值（現金 + 投資 + 手動資產 + 保險解約金 / 退休帳戶 + 租賃未回收成本 − 負債 − 信用卡未繳 − 分期未入帳）
 * 保險只計 cashValueTWD（純保障型 = 0）、退休帳戶以餘額計（accounts/valuation.ts longTermAccountValueTWD）
 * 信用卡未繳 = 已存有 amount 但 paidAt = null 的 bill 累加
 * 分期未入帳 = sum(active installment_plans 尚未入帳的期數金額)
 *   已入帳的期數已在信用卡帳戶餘額裡（GAS 入帳時 importAdjustAccount_），這裡只算未來還沒進卡片的部分；
 *   與 Apps Script NetWorth.gs installmentRemainingTWD_ 同口徑。
 * 租賃未回收成本 = sum(active rentals max(0, 成本 − 累積收款))
 *   購入時錢已從現金 / 銀行扣，這條是用來抵銷那筆扣減（避免雙重扣減）；
 *   隨著收租進來，未回收成本會降到 0，之後的收入直接以現金形式進帳。
 *
 * 顯示層：
 *   rawLiquidTWD = 帳戶實際餘額加總（可能因租賃購入而為負）
 *   liquidTWD    = rawLiquid + 被「吸收」用來抵銷負餘額的租賃未回收成本（不會 < 0，視覺友善）
 *   rentalUnrecoveredTWD = 顯示用「未被吸收的剩餘」租賃成本
 *   liquidTWD + rentalUnrecoveredTWD === rawLiquid + 全部 rentalUnrecovered（math 不變）
 */
export function useNetWorthNow() {
  const { data: accounts = [] } = useAccounts();
  const { data: cashAccounts = [] } = useCashAccounts();
  const { data: fxRates = [] } = useFxRates();
  const { data: assets = [] } = useManualAssets();
  const { data: invest } = useLatestSnapshot();
  const { data: bills = [] } = useAllBills();
  const { data: rentals = [] } = useRentals();
  const { data: installmentPlans = [] } = useInstallmentPlans();

  return useMemo(() => {
    const rawLiquid = totalLiquidTWD(accounts, cashAccounts, fxRates);
    const investment = invest?.totalValueTWD ?? 0;
    const manual = assets.reduce((s, a) => s + (a.valueTWD || 0), 0);
    const insurancePension = totalInsurancePensionTWD(accounts, fxRates);
    const rentalUnrecoveredRaw = totalUnrecoveredCostTWD(rentals);
    const liabilities = accounts
      .filter((account) => account.type === 'loan')
      .reduce((s, account) => s + currentDebtBalanceTWD(account, fxRates), 0);

    const today = startOfTWDay();
    const overdueBillOutstanding = bills.reduce((s, b) => {
      if (b.paidAt) return s;
      const due = effectiveDueDate(b);
      if (due.getTime() > today.getTime()) return s; // 尚未到期不計入
      return s + (b.amount ?? 0);
    }, 0);
    const creditCardBalance = accounts
      .filter((account) => account.type === 'credit_card')
      .reduce((s, account) => s + currentDebtBalanceTWD(account, fxRates), 0);
    const ccOutstanding = creditCardBalance > 0 ? creditCardBalance : overdueBillOutstanding;
    const installmentRemaining = totalInstallmentRemainingTWD(installmentPlans);

    // 把「租賃未回收」用來吸收 rawLiquid 的負值（如果 rawLiquid < 0）；
    // 沒被吸收的部份還是放在 rentalUnrecoveredTWD 顯示。math 不變。
    const absorbed = rawLiquid < 0
      ? Math.min(rentalUnrecoveredRaw, -rawLiquid)
      : 0;
    const displayLiquid = rawLiquid + absorbed;            // >= 0 if absorbable; else still negative
    const displayRentalUnrecovered = rentalUnrecoveredRaw - absorbed;

    const total = rawLiquid + investment + manual + insurancePension + rentalUnrecoveredRaw - liabilities - ccOutstanding - installmentRemaining;
    return {
      // 顯示層
      liquidTWD: displayLiquid,
      rentalUnrecoveredTWD: displayRentalUnrecovered,
      // 原始值（tooltip / snapshot 寫入用）
      rawLiquidTWD: rawLiquid,
      rentalUnrecoveredRawTWD: rentalUnrecoveredRaw,
      rentalAbsorbedTWD: absorbed,
      // 其餘
      investmentTWD: investment,
      manualAssetsTWD: manual,
      insurancePensionTWD: insurancePension,
      liabilitiesTWD: liabilities,
      creditCardOutstandingTWD: ccOutstanding,
      installmentRemainingTWD: installmentRemaining,
      netWorthTWD: total,
    };
  }, [accounts, cashAccounts, fxRates, assets, invest, bills, rentals, installmentPlans]);
}

/** 應急基金水位：現金（標 countsAsEmergencyFund）/ 月支出基準 */
export function useEmergencyFund(monthlyBaseline?: number | null, targetMonths = 6) {
  const { data: accounts = [] } = useAccounts();
  const { data: cashAccounts = [] } = useCashAccounts();
  const { data: fxRates = [] } = useFxRates();
  const { data: rentals = [] } = useRentals();
  return useMemo(() => {
    const accountLiquid = accounts
      .filter((account) => account.type === 'cash' || account.type === 'bank')
      .reduce((s, account) => s + currentAccountBalanceTWD(account, fxRates), 0);
    const legacyLiquid = unreconciledLegacyCashAccounts(cashAccounts, accounts)
      .filter((account) => account.countsAsEmergencyFund !== false)
      .reduce((s, account) => s + (account.amountTWD || account.amount || 0), 0);
    const rawLiquid = accountLiquid + legacyLiquid;
    // 應急基金不能因為「租賃購入暫時打負」而被算成 0；參照淨值的吸收邏輯
    const rentalUnrecovered = totalUnrecoveredCostTWD(rentals);
    const absorbed = rawLiquid < 0 ? Math.min(rentalUnrecovered, -rawLiquid) : 0;
    const liquid = Math.max(0, rawLiquid + absorbed);
    const target = (monthlyBaseline ?? 0) * targetMonths;
    const pct = target > 0 ? Math.min(100, (liquid / target) * 100) : 0;
    return { liquidTWD: liquid, targetTWD: target, pct, monthsCovered: monthlyBaseline ? liquid / monthlyBaseline : 0 };
  }, [accounts, cashAccounts, fxRates, monthlyBaseline, targetMonths, rentals]);
}

export type { NetWorthSnapshot };
