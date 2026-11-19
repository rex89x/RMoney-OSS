import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { addTWCalendarMonths, formatTWDateInput, formatTWMonthKey, monthTWRange, nowTW, startOfTWDay } from '@/lib/tz';
import { useCreateTransaction } from '@/features/ledger/hooks';
import {
  buildFundPlanStatus, fundPlanDueDate, fundPlanDueDay, fundPlanExpenseTxId, fundPlanShares, parseMonthKey,
} from './fund-plan';
import {
  convertFundEntryToReimbursement, createHousehold, createHouseholdFundEntry, createSettlement, deleteHouseholdFundEntry, deleteSettlement, updateHouseholdFundEntry,
  inviteHouseholdMember, listHouseholdFundEntries, listHouseholdTransactions, listMyHouseholds,
  listSettlements, removeHouseholdMember, subscribeHouseholdFundEntries, subscribeHouseholdTransactions,
  subscribeMyHouseholds, subscribeSettlements, updateHousehold, type ConvertToReimbursementInput, type HouseholdFundEntryPatch, type HouseholdPatch, type HouseholdTxFilters,
} from './api';
import {
  getLedgerShareState, listSharedLedgerTransactions, repairLedgerSharingMirror, setLedgerSharing,
  subscribeSharedLedgerTransactions, type LedgerShareScope, type LedgerShareState,
} from './ledger-share';
import { computeBalances, simplifyDebts, summarizeHouseholdFund, summarizeHouseholdTxs } from './balance';
import type { HouseholdFundSummary, MemberBalance, PairDebt } from './balance';
import type { Transaction } from '@/features/ledger/types';
import {
  HOUSEHOLD_FUND_PAYER_ID,
  type Household, type HouseholdFundEntry, type HouseholdFundEntryInput, type HouseholdFundFixedExpense, type HouseholdMember,
  type Settlement, type SettlementInput,
} from './types';
import { requireUid } from '@/lib/assert';

const HOUSEHOLD_KEY = 'households';

/**
 * 共同帳本的每一個彙總（誰欠誰 / 本月 / 公基金 / 交易列表）都吃同一份交易快照，
 * 避免以前各自用不同時間範圍導致「列表加總 ≠ 餘額」，也避免同一頁掛 4 個 onSnapshot。
 */
export const HOUSEHOLD_LEDGER_MONTHS = 24;
const HOUSEHOLD_LEDGER_LIMIT = 3000;

/**
 * 同一個 query key 只保留一個 Firestore listener（refcount）。
 * 多個元件同時用 useHouseholdLedger 時不會重複訂閱。
 */
const sharedSnapshots = new Map<string, { count: number; unsubscribe: () => void }>();

function useSharedSnapshot(key: string | null, start: () => () => void) {
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (!key) return undefined;
    const existing = sharedSnapshots.get(key);
    if (existing) existing.count += 1;
    else sharedSnapshots.set(key, { count: 1, unsubscribe: startRef.current() });
    return () => {
      const entry = sharedSnapshots.get(key);
      if (!entry) return;
      entry.count -= 1;
      if (entry.count <= 0) {
        entry.unsubscribe();
        sharedSnapshots.delete(key);
      }
    };
  }, [key]);
}

/** 目前使用者的共同帳本（單一；未建立 → null） */
export function useHousehold() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => [HOUSEHOLD_KEY, user?.uid] as const, [user?.uid]);
  const q = useQuery<Household[]>({
    queryKey,
    queryFn: () => listMyHouseholds(requireUid(user)),
    enabled: Boolean(user?.uid),
    staleTime: 60 * 1000,
  });
  useEffect(() => {
    if (!user?.uid) return undefined;
    return subscribeMyHouseholds(
      user.uid,
      (rows) => queryClient.setQueryData(queryKey, rows),
      (error) => console.error('[subscribeMyHouseholds]', error),
    );
  }, [queryClient, queryKey, user?.uid]);
  return { ...q, household: q.data?.[0] ?? null };
}

/** 有兩人以上的共同帳本才算「啟用」 */
export function useActiveHousehold(): Household | null {
  const { household } = useHousehold();
  return household && household.memberIds.length >= 2 ? household : null;
}

export function useCreateHousehold() {
  const qc = useQueryClient();
  const { user, profile } = useAuth();
  return useMutation({
    mutationFn: async (name: string) => {
      if (!user) throw new Error('Not logged in');
      const me: HouseholdMember = {
        uid: user.uid,
        displayName: profile?.displayName ?? user.displayName ?? user.email ?? '我',
        email: profile?.email ?? user.email ?? null,
      };
      return createHousehold(me, name);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: [HOUSEHOLD_KEY] }),
    onError: (err) => {
      console.error('[createHousehold]', err);
      toast.error(err instanceof Error ? err.message : '建立失敗');
    },
  });
}

export function useUpdateHousehold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: HouseholdPatch }) => updateHousehold(id, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [HOUSEHOLD_KEY] }),
    onError: (err) => {
      console.error('[updateHousehold]', err);
      toast.error(err instanceof Error ? err.message : '儲存失敗');
    },
  });
}

export function useRemoveHouseholdMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ household, uid }: { household: Household; uid: string }) => removeHouseholdMember(household, uid),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [HOUSEHOLD_KEY] }),
    onError: (err) => {
      console.error('[removeHouseholdMember]', err);
      toast.error(err instanceof Error ? err.message : '移除失敗');
    },
  });
}

export function useInviteHouseholdMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ householdId, email }: { householdId: string; email: string }) => inviteHouseholdMember(householdId, email),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [HOUSEHOLD_KEY] }),
    onError: (err) => {
      console.error('[inviteHouseholdMember]', err);
      toast.error(err instanceof Error ? err.message : '邀請失敗');
    },
  });
}

export function useHouseholdTransactions(filters: Omit<HouseholdTxFilters, 'householdId'>, householdId?: string | null) {
  const queryClient = useQueryClient();
  const startTime = filters.startDate?.getTime();
  const endTime = filters.endDate?.getTime();
  const rowLimit = filters.limit;
  const stableFilters = useMemo<Omit<HouseholdTxFilters, 'householdId'>>(() => ({
    startDate: startTime == null ? undefined : new Date(startTime),
    endDate: endTime == null ? undefined : new Date(endTime),
    limit: rowLimit,
  }), [endTime, rowLimit, startTime]);
  const queryKey = useMemo(
    () => ['transactions', 'household', householdId, stableFilters] as const,
    [householdId, stableFilters],
  );
  const result = useQuery({
    // 以 'transactions' 開頭，讓 ledger 的 create / delete invalidation 一起刷新
    queryKey,
    queryFn: () => listHouseholdTransactions({ ...stableFilters, householdId: householdId as string }),
    enabled: Boolean(householdId),
    staleTime: 30 * 1000,
  });
  useSharedSnapshot(
    householdId ? JSON.stringify(queryKey) : null,
    () => subscribeHouseholdTransactions(
      { householdId: householdId as string, ...stableFilters },
      (rows) => queryClient.setQueryData(queryKey, rows),
      (error) => console.error('[subscribeHouseholdTransactions]', error),
    ),
  );
  return result;
}

export function useSettlements(householdId?: string | null) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['household-settlements', householdId] as const, [householdId]);
  const result = useQuery({
    queryKey,
    queryFn: () => listSettlements(householdId as string),
    enabled: Boolean(householdId),
    staleTime: 30 * 1000,
  });
  useSharedSnapshot(
    householdId ? JSON.stringify(queryKey) : null,
    () => subscribeSettlements(
      householdId as string,
      (rows) => queryClient.setQueryData(queryKey, rows),
      (error) => console.error('[subscribeSettlements]', error),
    ),
  );
  return result;
}

export function useHouseholdFundEntries(householdId?: string | null) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['household-fund-entries', householdId] as const, [householdId]);
  const result = useQuery({
    queryKey,
    queryFn: () => listHouseholdFundEntries(householdId as string),
    enabled: Boolean(householdId),
    staleTime: 30 * 1000,
  });
  useSharedSnapshot(
    householdId ? JSON.stringify(queryKey) : null,
    () => subscribeHouseholdFundEntries(
      householdId as string,
      (rows) => queryClient.setQueryData(queryKey, rows),
      (error) => console.error('[subscribeHouseholdFundEntries]', error),
    ),
  );
  return result;
}

export function useCreateHouseholdFundEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ householdId, input }: { householdId: string; input: HouseholdFundEntryInput }) =>
      createHouseholdFundEntry(householdId, input),
    onSuccess: (_value, variables) => {
      void qc.invalidateQueries({ queryKey: ['household-fund-entries', variables.householdId] });
    },
    onError: (error) => {
      console.error('[createHouseholdFundEntry]', error);
      toast.error(error instanceof Error ? error.message : '公基金存入失敗');
    },
  });
}

export function useUpdateHouseholdFundEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ householdId, id, patch }: { householdId: string; id: string; patch: HouseholdFundEntryPatch }) =>
      updateHouseholdFundEntry(householdId, id, patch),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ['household-fund-entries', variables.householdId] });
    },
    onError: (error) => {
      console.error('[updateHouseholdFundEntry]', error);
      toast.error(error instanceof Error ? error.message : '修改公基金失敗');
    },
  });
}

/** 把記錯的公基金存入改成撥還（並標記對應支出是誰先墊），見 api.ts */
export function useConvertFundEntryToReimbursement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ConvertToReimbursementInput) => convertFundEntryToReimbursement(input),
    onSuccess: (_value, variables) => {
      void qc.invalidateQueries({ queryKey: ['household-fund-entries', variables.householdId] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
    onError: (error) => {
      console.error('[convertFundEntryToReimbursement]', error);
      toast.error(error instanceof Error ? error.message : '改成撥還失敗');
    },
  });
}

export function useDeleteHouseholdFundEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ householdId, id }: { householdId: string; id: string }) =>
      deleteHouseholdFundEntry(householdId, id),
    onSuccess: (_value, variables) => {
      void qc.invalidateQueries({ queryKey: ['household-fund-entries', variables.householdId] });
    },
    onError: (error) => {
      console.error('[deleteHouseholdFundEntry]', error);
      toast.error(error instanceof Error ? error.message : '刪除失敗');
    },
  });
}

export function useCreateSettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ householdId, input }: { householdId: string; input: SettlementInput }) => createSettlement(householdId, input),
    onSuccess: (_v, vars) => {
      void qc.invalidateQueries({ queryKey: ['household-settlements', vars.householdId] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err) => {
      console.error('[createSettlement]', err);
      toast.error(err instanceof Error ? err.message : '結算失敗');
    },
  });
}

export function useDeleteSettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ householdId, id }: { householdId: string; id: string }) => deleteSettlement(householdId, id),
    onSuccess: (_v, vars) => void qc.invalidateQueries({ queryKey: ['household-settlements', vars.householdId] }),
    onError: (err) => {
      console.error('[deleteSettlement]', err);
      toast.error(err instanceof Error ? err.message : '刪除失敗');
    },
  });
}

/** 共同帳本主資料：交易 / 結算 / 公基金只訂閱一次，所有彙總都由這份衍生 */
export interface HouseholdLedger {
  /** 近 HOUSEHOLD_LEDGER_MONTHS 個月、未刪除的共同支出（新到舊） */
  txs: Transaction[];
  settlements: Settlement[];
  fundEntries: HouseholdFundEntry[];
  balances: Record<string, MemberBalance>;
  debts: PairDebt[];
  fund: HouseholdFundSummary;
  /** 資料涵蓋的最早日期（台北時間當日 00:00） */
  since: Date;
  isLoading: boolean;
}

export function useHouseholdLedger(household: Household | null): HouseholdLedger {
  const since = useMemo(() => startOfTWDay(addTWCalendarMonths(nowTW(), -HOUSEHOLD_LEDGER_MONTHS)), []);
  const txQuery = useHouseholdTransactions({ startDate: since, limit: HOUSEHOLD_LEDGER_LIMIT }, household?.id);
  const settlementsQuery = useSettlements(household?.id);
  const fundQuery = useHouseholdFundEntries(household?.id);

  const txs = useMemo(
    () => (txQuery.data ?? []).filter((tx) => tx.type === 'expense' && !tx.deletedAt),
    [txQuery.data],
  );
  const settlements = useMemo(() => settlementsQuery.data ?? [], [settlementsQuery.data]);
  const fundEntries = useMemo(() => fundQuery.data ?? [], [fundQuery.data]);

  const balances = useMemo(
    () => (household ? computeBalances(household, txs, settlements) : {}),
    [household, txs, settlements],
  );
  const debts = useMemo(() => simplifyDebts(balances), [balances]);
  const fund = useMemo(() => summarizeHouseholdFund(fundEntries, txs), [fundEntries, txs]);

  return {
    txs,
    settlements,
    fundEntries,
    balances,
    debts,
    fund,
    since,
    isLoading: txQuery.isLoading || settlementsQuery.isLoading || fundQuery.isLoading,
  };
}

/** 誰欠誰（由 useHouseholdLedger 衍生，與交易列表同一份資料） */
export function useHouseholdBalance(household: Household | null) {
  const { balances, debts, txs, settlements, isLoading } = useHouseholdLedger(household);
  return { balances, debts, txs, settlements, isLoading };
}

/** 本月（台北時間）共同支出彙總 */
export function useHouseholdMonthSummary(household: Household | null) {
  const { txs, isLoading } = useHouseholdLedger(household);
  // 以台北月份當 key，跨月時會自動換成新的區間（不要用 useMemo(..., []) 鎖住）
  const monthKey = formatTWMonthKey(new Date());
  const range = useMemo(() => {
    const [year, month] = monthKey.split('-');
    return monthTWRange(Number(year), Number(month));
  }, [monthKey]);
  const monthTxs = useMemo(
    () => txs.filter((tx) => tx.date >= range.start && tx.date <= range.end),
    [txs, range],
  );
  const summary = useMemo(() => summarizeHouseholdTxs(monthTxs, household?.memberIds), [monthTxs, household?.memberIds]);
  return { summary, range, txs: monthTxs, isLoading };
}

/** 公基金：餘額 = 累計存入 − 公基金支付的共同支出 */
export function useHouseholdFundSummary(household: Household | null) {
  const { fund, fundEntries, txs, isLoading } = useHouseholdLedger(household);
  const fundExpenses = useMemo(
    () => txs.filter((tx) => tx.paidByUid === HOUSEHOLD_FUND_PAYER_ID),
    [txs],
  );
  return { summary: fund, entries: fundEntries, fundExpenses, isLoading };
}

// ------- 公基金每月計畫 -------

/** 本月的計畫進度（每人存了沒、固定扣款扣了沒、可用月數）；計畫未設定時回 null */
export function useFundPlanStatus(household: Household | null) {
  const { fund, fundEntries, txs, isLoading } = useHouseholdLedger(household);
  // 以台北日期當 key：跨日／跨月時重算「到期」狀態
  const dayKey = formatTWDateInput(new Date());
  const status = useMemo(() => {
    const plan = household?.fundPlan;
    if (!household || !plan || !plan.enabled) return null;
    return buildFundPlanStatus({ household, plan, entries: fundEntries, txs, balanceTWD: fund.balanceTWD, now: new Date() });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dayKey 讓跨日時重算
  }, [household, fundEntries, txs, fund.balanceTWD, dayKey]);
  return { status, isLoading };
}

/**
 * 「立即扣款」：本月固定扣款還沒到日或自動化還沒跑時，手動從公基金建立那一筆。
 * 交易 id 與 Apps Script 相同（fundplan_{hid}_{itemId}_{yyyyMM}），誰先建立都只會有一筆。
 */
export function useChargeFundPlanExpense() {
  const createTx = useCreateTransaction({ silentSuccess: true });
  return useMutation({
    mutationFn: async ({ household, item, monthKey }: { household: Household; item: HouseholdFundFixedExpense; monthKey: string }) => {
      const parsed = parseMonthKey(monthKey);
      if (!parsed) throw new Error('月份格式錯誤');
      const day = fundPlanDueDay(item.dayOfMonth, parsed.year, parsed.month);
      return createTx.mutateAsync({
        clientRequestId: fundPlanExpenseTxId(household.id, item.id, monthKey),
        type: 'expense',
        amount: item.amountTWD,
        currency: 'TWD',
        amountTWD: item.amountTWD,
        fxRate: 1,
        category: item.categoryKey,
        paymentMethod: '公基金',
        fromAccountId: null,
        toAccountId: null,
        note: item.name || '公基金固定扣款',
        date: fundPlanDueDate(parsed.year, parsed.month, day),
        scope: 'household',
        householdId: household.id,
        tripId: null,
        payerId: null,
        paidByUid: HOUSEHOLD_FUND_PAYER_ID,
        shareType: 'custom',
        customShares: fundPlanShares(item.amountTWD, household.memberIds, household.splitRatio),
        myShareTWD: 0,
        tags: ['共同', '公基金固定扣款'],
      });
    },
    onSuccess: () => toast.success('已從公基金扣款'),
    onError: (error) => {
      console.error('[chargeFundPlanExpense]', error);
    },
  });
}

// ------- 個人支出分享（owner → 伴侶） -------

const LEDGER_SHARED_KEY = 'ledger-shared-with';

/**
 * 我實際開放給誰 —— 讀 `users/{uid}.ledgerSharedWith` / `.ledgerEditors`，也就是 rules 真正看的那份。
 * UI 的開關一律以這個為準，不要用 households.ledgerSharing / ledgerEditing 鏡像（鏡像只給對方判斷分頁）。
 */
export function useMyLedgerShareState() {
  const { user } = useAuth();
  return useQuery<LedgerShareState>({
    queryKey: [LEDGER_SHARED_KEY, user?.uid],
    queryFn: () => getLedgerShareState(requireUid(user)),
    enabled: Boolean(user?.uid),
    staleTime: 30 * 1000,
  });
}

/** 切換「讓某位成員看到（scope 'view'）／編輯（scope 'edit'）我的個人支出」。只能改自己的分享設定。 */
export function useSetLedgerSharing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { household: Household; sharerUid: string; viewerUid: string; enabled: boolean; scope?: LedgerShareScope }) =>
      setLedgerSharing(params),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [HOUSEHOLD_KEY] });
      void qc.invalidateQueries({ queryKey: [LEDGER_SHARED_KEY] });
    },
    onError: (error) => {
      console.error('[setLedgerSharing]', error);
      toast.error(error instanceof Error ? error.message : '儲存分享設定失敗');
    },
  });
}

/** 權威來源與 household 鏡像不一致時，用權威來源重寫鏡像 */
export function useRepairLedgerSharingMirror() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ household, sharerUid }: { household: Household; sharerUid: string }) =>
      repairLedgerSharingMirror(household, sharerUid),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [HOUSEHOLD_KEY] });
      void qc.invalidateQueries({ queryKey: [LEDGER_SHARED_KEY] });
      toast.success('已重新同步分享設定');
    },
    onError: (error) => {
      console.error('[repairLedgerSharingMirror]', error);
      toast.error(error instanceof Error ? error.message : '同步失敗');
    },
  });
}

/**
 * 讀對方分享出來的個人支出（單月）。
 * rules 要求 query 一定帶 `type == 'expense'`，被拒時 onSnapshot 會噴 permission-denied，
 * 這裡把錯誤收進 `error` 讓 UI 顯示「對方已取消分享」而不是整頁壞掉。
 */
export function useSharedLedgerMonth(sharerUid: string | null | undefined, year: number, month: number) {
  const queryClient = useQueryClient();
  const range = useMemo(() => monthTWRange(year, month), [year, month]);
  const queryKey = useMemo(
    () => ['shared-ledger', sharerUid, year, month] as const,
    [sharerUid, year, month],
  );
  const [error, setError] = useState<Error | null>(null);
  // 換月份 = 換一條訂閱，上個月的錯誤不該留在畫面上
  useEffect(() => { setError(null); }, [queryKey]);
  const result = useQuery({
    queryKey,
    queryFn: () => listSharedLedgerTransactions({
      sharerUid: sharerUid as string,
      startDate: range.start,
      endDate: range.end,
    }),
    enabled: Boolean(sharerUid),
    retry: false,
    staleTime: 30 * 1000,
  });
  useSharedSnapshot(
    sharerUid ? JSON.stringify(queryKey) : null,
    () => subscribeSharedLedgerTransactions(
      { sharerUid: sharerUid as string, startDate: range.start, endDate: range.end },
      (rows) => {
        setError(null);
        queryClient.setQueryData(queryKey, rows);
      },
      (subscribeError) => {
        console.error('[subscribeSharedLedgerTransactions]', subscribeError);
        setError(subscribeError);
      },
    ),
  );
  return {
    txs: result.data ?? [],
    range,
    isLoading: result.isLoading,
    error: error ?? (result.error as Error | null),
  };
}
