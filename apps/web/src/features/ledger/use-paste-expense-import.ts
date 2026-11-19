import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { useAccounts } from '@/features/accounts';
import { memberCan, useHousehold } from '@/features/household';
import { useCreateTrip, useTrips } from '@/features/trips';
import { getTrip } from '@/features/trips/api';
import { dateInputToTWDate, formatTWDateInput, startOfTWDay } from '@/lib/tz';
import type { Trip } from '@/features/trips/types';
import { listCategories, listTransactions } from './api';
import { useCategories } from './hooks';
import {
  availableModes,
  autoCategoryKey,
  autoMemberMap,
  autoTripId,
  dateRangeOf,
  defaultImportMode,
  PARTNER_PERSON,
  PERSON_NAME,
  planRow,
  SELF_PERSON,
  type ImportMode,
  type RowPlan,
  type SourcePerson,
} from './paste-import-plan';
import { loadSettings, saveSettings, type SavedSettings } from './paste-import-settings';
import { importPasteExpense, parsePasteTransfer, verifyTransferItem, type PasteReceiptItem, type PasteTransfer, type PasteTransferItem } from './paste-transfer';

/** 使用者選「不歸屬 RMoney 旅程」時存的值。 */
export const NO_TRIP = '__none__';

export interface TripGroup {
  sourceTripKey: string;
  nameHint: string;
  items: PasteTransferItem[];
  /** '' = 還沒選、NO_TRIP = 不歸屬、其他 = RMoney trip id */
  choice: string;
  trip: Trip | null;
  noTrip: boolean;
  memberMap: Record<SourcePerson, string>;
}

export interface PreviewRow {
  item: PasteTransferItem;
  plan: RowPlan;
  similar: boolean;
  selected: boolean;
  result?: PasteReceiptItem;
  error?: string;
}

export function usePasteExpenseImport() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: accounts = [] } = useAccounts();
  const { data: categories = [] } = useCategories();
  const { data: trips = [] } = useTrips();
  const { household } = useHousehold();
  const createTrip = useCreateTrip();

  const [text, setText] = useState('');
  const [transfer, setTransfer] = useState<PasteTransfer | null>(null);
  const [parseError, setParseError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [settings, setSettings] = useState<SavedSettings>(() => loadSettings());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [similar, setSimilar] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, PasteReceiptItem>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const parseSeq = useRef(0);

  const updateSettings = useCallback((patch: (prev: SavedSettings) => SavedSettings) => {
    setSettings((prev) => {
      const next = patch(prev);
      saveSettings(next);
      return next;
    });
  }, []);

  const myAccounts = useMemo(
    () => accounts.filter((row) => row.active && !row.archivedAt && row.ownerId === user?.uid),
    [accounts, user?.uid],
  );
  const expenseCategories = useMemo(
    () => categories.filter((category) => category.type === 'expense' && !category.archivedAt),
    [categories],
  );
  const householdReady = Boolean(
    user && household && household.memberIds.length === 2 && memberCan(household, user.uid, 'canAddExpense'),
  );

  const targetKind = transfer?.items[0]?.target.kind ?? 'general';

  const modes = availableModes(householdReady);
  const mode: ImportMode = settings.mode && modes.includes(settings.mode) ? settings.mode : defaultImportMode(householdReady);
  const counterpartyName = settings.counterpartyName ?? PERSON_NAME[PARTNER_PERSON];

  const savedAccount = myAccounts.find((row) => row.id === settings.accountId);
  const account = savedAccount ?? (myAccounts.length === 1 ? myAccounts[0] ?? null : null);

  // 一次貼上可以包含好幾趟旅程；每趟各自對應一個 RMoney 旅程（或不歸屬旅程）。
  const tripGroups: TripGroup[] = useMemo(() => {
    if (!transfer || targetKind !== 'trip') return [];
    const byKey = new Map<string, PasteTransferItem[]>();
    for (const item of transfer.items) byKey.set(item.target.sourceTripKey, [...(byKey.get(item.target.sourceTripKey) ?? []), item]);
    return [...byKey.entries()].map(([sourceTripKey, items]) => {
      const nameHint = items[0]?.target.nameHint ?? '';
      const saved = settings.tripBySource?.[sourceTripKey];
      const choice = saved === NO_TRIP || trips.some((trip) => trip.id === saved) ? (saved ?? '') : autoTripId(nameHint, trips);
      const trip = choice && choice !== NO_TRIP ? trips.find((row) => row.id === choice) ?? null : null;
      const autoMembers = autoMemberMap(trip, user?.uid ?? '');
      const savedMembers = trip ? settings.memberMapByTrip?.[trip.id] : undefined;
      const keys = new Set((trip?.members ?? []).map((member) => member.uid ?? member.name));
      const memberMap: Record<SourcePerson, string> = {
        ming: savedMembers?.ming && keys.has(savedMembers.ming) ? savedMembers.ming : autoMembers.ming,
        chiau: savedMembers?.chiau && keys.has(savedMembers.chiau) ? savedMembers.chiau : autoMembers.chiau,
      };
      return { sourceTripKey, nameHint, items, choice, trip, noTrip: choice === NO_TRIP, memberMap };
    });
  }, [transfer, targetKind, settings.tripBySource, settings.memberMapByTrip, trips, user?.uid]);

  const hints = useMemo(() => [...new Set(transfer?.items.map((item) => item.categoryHint) ?? [])], [transfer]);
  const categoryMap = useMemo(() => {
    const out: Record<string, string> = {};
    for (const hint of hints) {
      const saved = settings.categoryMap?.[`${targetKind}:${hint}`];
      out[hint] = saved && expenseCategories.some((category) => category.key === saved)
        ? saved
        : autoCategoryKey(hint, targetKind, expenseCategories);
    }
    return out;
  }, [hints, settings.categoryMap, targetKind, expenseCategories]);

  // 每列只算一次（之前每次 render 每列要重建 input 兩次，列一多輸入就卡）。
  const rows: PreviewRow[] = useMemo(() => {
    if (!transfer || !user) return [];
    const groupByKey = new Map(tripGroups.map((group) => [group.sourceTripKey, group]));
    return transfer.items.map((item) => {
      const group = groupByKey.get(item.target.sourceTripKey);
      const date = dateInputToTWDate(item.date) ?? new Date(Number.NaN);
      const plan = planRow(item, {
        uid: user.uid, mode, targetKind, account, categoryKey: categoryMap[item.categoryHint] ?? '',
        trip: group?.trip ?? null, noTrip: group?.noTrip ?? false,
        memberMap: group?.memberMap ?? { ming: '', chiau: '' },
        household: householdReady ? household : null, counterpartyName, date,
      });
      const result = results[item.sourceId];
      return {
        item,
        plan,
        similar: similar.has(item.sourceId),
        selected: plan.ok && !result && !excluded.has(item.sourceId),
        result,
        error: rowErrors[item.sourceId],
      };
    });
  }, [transfer, user, mode, targetKind, account, categoryMap, tripGroups, householdReady, household, counterpartyName, results, excluded, similar, rowErrors]);

  const selectedRows = rows.filter((row) => row.selected);
  const summary = {
    count: selectedRows.length,
    chargedTWD: selectedRows.reduce((sum, row) => sum + (row.plan.ok ? row.plan.chargedTWD : 0), 0),
    myShareTWD: selectedRows.reduce((sum, row) => sum + (row.plan.ok ? row.plan.myShareTWD : 0), 0),
    skipped: rows.filter((row) => !row.plan.ok && row.plan.skipped && !row.result).length,
    blocked: rows.filter((row) => !row.plan.ok && !row.plan.skipped && !row.result).length,
    imported: Object.keys(results).length,
    selectable: rows.filter((row) => row.plan.ok && !row.result).length,
    similar: rows.filter((row) => row.similar && row.plan.ok && !row.result && !row.selected).length,
  };
  const needsAccount = rows.some((row) => !row.result && row.item.paidByHint === SELF_PERSON && !account);

  const reset = useCallback(() => {
    parseSeq.current += 1;
    setText('');
    setTransfer(null);
    setParseError('');
    setExcluded(new Set());
    setSimilar(new Set());
    setResults({});
    setRowErrors({});
    setProgress({ done: 0, total: 0 });
  }, []);

  // 貼上後自動解析，不用再按「解析並預覽」。
  useEffect(() => {
    const value = text.trim();
    if (!value) { setParseError(''); setParsing(false); return undefined; }
    const seq = ++parseSeq.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        setParsing(true);
        try {
          const parsed = parsePasteTransfer(value);
          for (const item of parsed.items) await verifyTransferItem(item);
          if (new Set(parsed.items.map((item) => item.target.kind)).size !== 1) {
            throw new Error('旅程支出和一般支出請分開複製。');
          }
          if (seq !== parseSeq.current) return;
          setTransfer(parsed);
          setParseError('');
          setResults({});
          setRowErrors({});
          setExcluded(new Set());
          setSimilar(new Set());
          void findSimilar(parsed, seq);
        } catch (cause) {
          if (seq !== parseSeq.current) return;
          setTransfer(null);
          setParseError(cause instanceof Error ? cause.message : '無法解析匯入資料。');
        } finally {
          if (seq === parseSeq.current) setParsing(false);
        }
      })();
    }, 200);
    return () => window.clearTimeout(timer);
    // findSimilar 只讀 user，刻意不放進依賴避免重跑解析。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  /** 舊的手動交易沒有來源 ID；同日同額同備註的列預設不勾，讓使用者自己決定。 */
  async function findSimilar(parsed: PasteTransfer, seq: number): Promise<void> {
    if (!user) return;
    const dates = parsed.items.map((item) => item.date).sort();
    const first = dates[0];
    const last = dates[dates.length - 1];
    if (!first || !last) return;
    try {
      const startDate = dateInputToTWDate(first);
      const endDate = dateInputToTWDate(last);
      if (!startDate || !endDate) return;
      const txs = await listTransactions({
        userId: user.uid,
        startDate,
        endDate: new Date(endDate.getTime() + 24 * 60 * 60 * 1000 - 1),
        limit: 500,
      });
      if (seq !== parseSeq.current) return;
      const hits = parsed.items.filter((item) => txs.some((tx) =>
        !tx.importSourceId && formatTWDateInput(tx.date) === item.date && tx.amount === item.amount &&
        (tx.note ?? '').trim() === item.note.trim(),
      )).map((item) => item.sourceId);
      setSimilar(new Set(hits));
      setExcluded((prev) => new Set([...prev, ...hits]));
    } catch (err) {
      // 疑似重複只是輔助提示；正式匯入仍靠來源 ID 冪等檢查擋重複。
      console.error('[pasteImport.findSimilar]', err);
    }
  }

  async function pasteFromClipboard(): Promise<void> {
    try {
      const value = await navigator.clipboard.readText();
      if (!value.trim()) { toast.error('剪貼簿是空的，請先在巧明日常按「複製」'); return; }
      setText(value);
    } catch (err) {
      console.error('[pasteImport.readClipboard]', err);
      toast.error('瀏覽器不允許讀取剪貼簿，請長按輸入框貼上');
    }
  }

  function toggleRow(sourceId: string, include: boolean): void {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (include) next.delete(sourceId); else next.add(sourceId);
      return next;
    });
  }

  function setMode(next: ImportMode): void { updateSettings((prev) => ({ ...prev, mode: next })); }
  function setAccountId(id: string): void { updateSettings((prev) => ({ ...prev, accountId: id })); }
  function setTripChoice(sourceTripKey: string, choice: string): void {
    updateSettings((prev) => ({ ...prev, tripBySource: { ...prev.tripBySource, [sourceTripKey]: choice } }));
  }
  function setCategory(hint: string, key: string): void {
    updateSettings((prev) => ({ ...prev, categoryMap: { ...prev.categoryMap, [`${targetKind}:${hint}`]: key } }));
  }
  function setCounterpartyName(name: string): void { updateSettings((prev) => ({ ...prev, counterpartyName: name })); }
  function setMember(group: TripGroup, person: SourcePerson, key: string): void {
    const trip = group.trip;
    if (!trip) return;
    updateSettings((prev) => ({
      ...prev,
      memberMapByTrip: { ...prev.memberMapByTrip, [trip.id]: { ...group.memberMap, [person]: key } },
    }));
  }

  /** RMoney 還沒有這趟旅程時，用巧明日常的名稱與費用日期直接建立。 */
  async function createTripFor(group: TripGroup): Promise<void> {
    const range = dateRangeOf(group.items);
    const startDate = range ? dateInputToTWDate(range.start) : null;
    const endDate = range ? dateInputToTWDate(range.end) : null;
    if (!startDate || !endDate) return;
    try {
      const id = await createTrip.mutateAsync({
        trip: {
          name: group.nameHint || '巧明日常旅程',
          destination: [],
          startDate,
          endDate,
          baseCurrency: 'TWD',
          foreignCurrencies: [],
          budget: 0,
          status: endDate.getTime() < startOfTWDay(new Date()).getTime() ? 'done' : 'planning',
        },
      });
      setTripChoice(group.sourceTripKey, id);
    } catch (err) {
      console.error('[pasteImport.createTrip]', err);
      toast.error(err instanceof Error ? err.message : '建立旅程失敗');
    }
  }

  /** 批次勾選：只動目前可以匯入的列；includeSimilar 決定疑似重複的要不要一起勾。 */
  function selectAll(include: boolean, includeSimilar = false): void {
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const row of rows) {
        if (!row.plan.ok || row.result) continue;
        if (!include) next.add(row.item.sourceId);
        else if (!row.similar || includeSimilar) next.delete(row.item.sourceId);
      }
      return next;
    });
  }

  async function runImport(): Promise<void> {
    if (!user || busy || selectedRows.length === 0) return;
    setBusy(true);
    setProgress({ done: 0, total: selectedRows.length });
    const done: Record<string, PasteReceiptItem> = { ...results };
    const errors: Record<string, string> = {};
    try {
      // 入帳前再確認一次類別／旅程還在（可能在別的分頁被封存或刪除）。
      const freshCategories = await listCategories();
      const usedKeys = new Set(selectedRows.map((row) => (row.plan.ok ? row.plan.input.category : '')));
      for (const key of usedKeys) {
        if (!freshCategories.some((category) => category.type === 'expense' && category.key === key && !category.archivedAt)) {
          throw new Error('有類別已封存或不存在，請重新選擇。');
        }
      }
      for (const group of tripGroups) {
        if (group.trip && !(await getTrip(group.trip.id))) throw new Error(`RMoney 旅程「${group.trip.name}」已不存在或沒有權限。`);
      }

      // 同一個帳戶的餘額要逐筆累加，所以依序寫入；單筆失敗不擋其他筆。
      let count = 0;
      for (const row of selectedRows) {
        if (!row.plan.ok) continue;
        try {
          done[row.item.sourceId] = await importPasteExpense(row.item, row.plan.input);
        } catch (err) {
          console.error('[pasteImport.row]', err);
          errors[row.item.sourceId] = err instanceof Error ? err.message : '匯入失敗';
        }
        count += 1;
        setProgress({ done: count, total: selectedRows.length });
      }
      setResults({ ...done });
      setRowErrors(errors);
      const okCount = Object.keys(done).length - Object.keys(results).length;
      const failCount = Object.keys(errors).length;
      if (failCount > 0) toast.error(`${okCount} 筆成功、${failCount} 筆失敗，失敗的列可修正後再匯入`);
      else toast.success(`已匯入 ${okCount} 筆，記得把回執貼回巧明日常`);
    } catch (err) {
      console.error('[pasteImport]', err);
      toast.error(err instanceof Error ? err.message : '匯入中斷，已成功的筆數會保留');
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['trips'] });
    }
  }

  const receiptItems = Object.values(results);
  const receipt = JSON.stringify({ format: 'rmoney-import-receipt', version: 1, items: receiptItems });

  async function copyReceipt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(receipt);
      toast.success('已複製回執，到巧明日常「費用」貼上即可');
    } catch (err) {
      console.error('[pasteImport.copyReceipt]', err);
      toast.error('複製失敗，請展開回執手動複製');
    }
  }

  return {
    text, setText, pasteFromClipboard, reset, parsing, parseError, transfer,
    targetKind, modes, mode, setMode, counterpartyName, setCounterpartyName,
    myAccounts, account, setAccountId, needsAccount,
    trips, tripGroups, setTripChoice, setMember, createTripFor, creatingTrip: createTrip.isPending,
    selectAll,
    hints, categoryMap, setCategory, expenseCategories,
    rows, toggleRow, summary,
    busy, progress, runImport,
    receiptCount: receiptItems.length, receipt, copyReceipt,
  };
}
