import { useEffect, useMemo, useState } from 'react';
import { collectTags } from '@/features/ledger/tags';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CreditCard, History } from 'lucide-react';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { ScrollTabsList } from '@/components/ui/scroll-tabs';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/page-header';
import { FinancialPlanningPanel, useCategories, useTransactions } from '@/features/ledger';
import { TransactionList, dayTotalsOf } from '@/features/ledger/components/transaction-list';
import { AnalysisPanel, RANGE_TX_LIMIT } from '@/features/analytics';
import { TX_SCOPE_LABEL, txScopes, useExpenseBreakdown, type TxScope } from '@/features/ledger/use-my-share';
import { ErrorBoundary } from '@/components/error-boundary';
import {
  DataTablePagination, DataTableToolbar, useDataTable, type FilterDef,
} from '@/components/data-table';
import { BulkSettleDialog } from '@/features/ledger/components/bulk-settle-dialog';
import { LoansPanel } from '@/features/ledger/components/loans-panel';
import { TrashPanel } from '@/features/ledger/components/trash-panel';
import { PasteExpenseImport } from '@/features/ledger/components/paste-expense-import';
import { AiImportPanel } from '@/features/import';
import { useAuth } from '@/hooks/use-auth';
import { RentalsPanel } from '@/features/rentals';
import { InstallmentsPanel } from '@/features/installments';
import { cn, formatCurrency } from '@/lib/utils';
import { dateInputToTWBoundary, formatDateInput, nowTW, parseDateInput } from '@/lib/tz';
import type { Transaction } from '@/features/ledger/types';

const LEDGER_TABS = ['list', 'analysis', 'import', 'loans', 'installments', 'rentals', 'planning', 'trash'] as const;
/** installment_plans 是 owner-only collection（firestore.rules），member 不顯示 */
const OWNER_ONLY_TABS = ['import', 'installments'];
/** 舊網址相容：儀表板 → 分析、貼上匯入 / AI 匯入 → 匯入 */
const TAB_ALIASES: Record<string, { tab: string; importMode?: ImportMode }> = {
  dashboard: { tab: 'analysis' },
  paste: { tab: 'import', importMode: 'paste' },
  ai: { tab: 'import', importMode: 'ai' },
};
type ImportMode = 'paste' | 'ai';

export default function LedgerPage() {
  const { isOwner } = useAuth();
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab') ?? '';
  const alias = TAB_ALIASES[rawTab];
  const resolvedTab = alias?.tab ?? rawTab;
  const tab = (LEDGER_TABS as readonly string[]).includes(resolvedTab)
    && (!OWNER_ONLY_TABS.includes(resolvedTab) || isOwner) ? resolvedTab : 'list';
  const importMode: ImportMode = (alias?.importMode ?? params.get('import')) === 'ai' ? 'ai' : 'paste';
  const setTab = (v: string) => {
    const next = new URLSearchParams(params);
    next.delete('import');
    if (v === 'list') next.delete('tab'); else next.set('tab', v);
    setParams(next, { replace: true });
  };
  const setImportMode = (m: ImportMode) => {
    const next = new URLSearchParams(params);
    next.set('tab', 'import');
    if (m === 'ai') next.set('import', 'ai'); else next.delete('import');
    setParams(next, { replace: true });
  };
  return (
    <ErrorBoundary scope="Ledger">
      <PageHeader title="記帳" description="交易、分析、匯入、代墊、分期" />

      <Tabs value={tab} onValueChange={setTab}>
        <ScrollTabsList
          aria-label="記帳分頁"
          value={tab}
          items={[
          { value: 'list', label: '交易' },
          { value: 'analysis', label: '分析' },
          ...(isOwner ? [{ value: 'import', label: '匯入' }] : []),
          { value: 'loans', label: '代墊' },
          ...(isOwner ? [{ value: 'installments', label: '分期' }] : []),
          { value: 'rentals', label: '租賃' },
          { value: 'planning', label: '理財' },
          { value: 'trash', label: '回收筒' },
          ]}
        />

        <TabsContent value="list" className="space-y-3">
          <TransactionsTable />
        </TabsContent>

        <TabsContent value="analysis">
          <AnalysisPanel />
        </TabsContent>

        {isOwner ? (
          <TabsContent value="import" className="space-y-3">
            <div className="inline-flex rounded-md border bg-muted/30 p-0.5 text-xs">
              {([['paste', '貼上文字 / 銀行明細'], ['ai', 'AI JSON 匯入']] as const).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setImportMode(m)}
                  className={cn(
                    'rounded px-3 py-1 transition-colors',
                    importMode === m ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {importMode === 'ai' ? <AiImportPanel /> : <PasteExpenseImport />}
          </TabsContent>
        ) : null}

        <TabsContent value="loans">
          <LoansPanel />
        </TabsContent>

        {isOwner ? (
          <TabsContent value="installments">
            <InstallmentsPanel />
          </TabsContent>
        ) : null}

        <TabsContent value="rentals">
          <RentalsPanel />
        </TabsContent>

        <TabsContent value="planning">
          <FinancialPlanningPanel />
        </TabsContent>

        <TabsContent value="trash">
          <TrashPanel />
        </TabsContent>
      </Tabs>
    </ErrorBoundary>
  );
}

function TransactionsTable() {
  // 預設載入近 12 個月，交給 DataTable 本地搜尋 / 篩選 / 分頁；
  // 日期篩選或「載入更早」會把載入起點往前推（例如從年度回顧點進來看去年的交易）。
  const [params] = useSearchParams();
  const [earliestKey, setEarliestKey] = useState<string>(() => {
    const now = nowTW();
    const def = formatDateInput(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()));
    const fromUrl = params.get('tx_date_start');
    return fromUrl && parseDateInput(fromUrl) && fromUrl < def ? fromUrl : def;
  });
  const windowStart = useMemo(() => dateInputToTWBoundary(earliestKey, 'start') ?? undefined, [earliestKey]);
  const { data: txs = [], isLoading } = useTransactions({ startDate: windowStart, limit: RANGE_TX_LIMIT });
  const truncated = txs.length >= RANGE_TX_LIMIT;
  const { data: categories = [] } = useCategories();

  const tagOptions = useMemo(() => collectTags(txs), [txs]);
  const filters: FilterDef[] = useMemo(() => [
    {
      id: 'type',
      label: '類型',
      kind: 'select',
      options: [
        { value: 'expense', label: '支出' },
        { value: 'income', label: '收入' },
      ],
    },
    {
      id: 'category',
      label: '類別',
      kind: 'multiSelect',
      options: categories.map((c) => ({ value: c.key, label: c.name })),
    },
    {
      id: 'paymentMethod',
      label: '支付方式',
      kind: 'multiSelect',
      options: uniquePaymentMethods(txs).map((p) => ({ value: p, label: p })),
    },
    {
      id: 'scope',
      label: '範疇',
      kind: 'select',
      options: (Object.keys(TX_SCOPE_LABEL) as TxScope[]).map((k) => ({ value: k, label: TX_SCOPE_LABEL[k] })),
    },
    {
      id: 'settleStatus',
      label: '結算',
      kind: 'select',
      options: [
        { value: 'settled', label: '已結算' },
        { value: 'unsettled', label: '未結算' },
      ],
    },
    ...(tagOptions.length
      ? [{ id: 'tags', label: '標籤', kind: 'multiSelect' as const, options: tagOptions.map((t) => ({ value: t, label: t })) }]
      : []),
    { id: 'date', label: '日期', kind: 'dateRange' },
  ], [categories, txs, tagOptions]);

  const accessor = useMemo(() => (row: Transaction, id: string) => {
    switch (id) {
      case 'note': return row.note ?? '';
      case 'category': return row.category;
      case 'paymentMethod': return row.paymentMethod;
      case 'type': return row.type;
      case 'date': return row.date;
      case 'amount': return row.amount;
      case 'amountTWD': return row.amountTWD;
      case 'settleStatus': return row.settledAmountTWD != null ? 'settled' : 'unsettled';
      case 'scope': return txScopes(row);
      case 'tags': return row.tags ?? [];
      default: return (row as unknown as Record<string, unknown>)[id];
    }
  }, []);

  const table = useDataTable<Transaction>({
    data: txs,
    accessor,
    searchFields: ['note', 'category', 'paymentMethod', 'amount', 'amountTWD', 'tags'],
    filters,
    pageSize: 25,
    urlKey: 'tx',
  });

  // 日期篩選早於目前載入範圍 → 自動往前載
  const filterStart = (table.filterValues.date as { start?: string } | undefined)?.start;
  useEffect(() => {
    if (filterStart && parseDateInput(filterStart) && filterStart < earliestKey) setEarliestKey(filterStart);
  }, [filterStart, earliestKey]);

  function loadEarlier() {
    const d = parseDateInput(earliestKey);
    if (!d) return;
    setEarliestKey(formatDateInput(new Date(d.getFullYear() - 1, d.getMonth(), d.getDate())));
  }

  // 篩選區間的合計（全部頁，不只當頁）：我負擔 = 實際花的；我墊付 − 我負擔 = 待收 / 待付
  const breakdown = useExpenseBreakdown();
  const rangeTotal = useMemo(() => {
    let income = 0;
    let expenseTotal = 0;
    let share = 0;
    let paid = 0;
    for (const t of table.filteredRows) {
      if (t.type === 'income') income += t.amountTWD;
      else if (t.type === 'expense') {
        const b = breakdown(t);
        expenseTotal += b.totalTWD;
        share += b.shareTWD;
        paid += b.paidTWD;
      }
    }
    return { income, expenseTotal, share, paid, net: paid - share };
  }, [table.filteredRows, breakdown]);
  const dayTotals = useMemo(() => dayTotalsOf(table.filteredRows, breakdown), [table.filteredRows, breakdown]);

  function applyDateChip(days: number | 'thisMonth' | 'lastMonth') {
    const now = nowTW();
    let startD: Date; let endD: Date;
    if (days === 'thisMonth') {
      startD = new Date(now.getFullYear(), now.getMonth(), 1);
      endD = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    } else if (days === 'lastMonth') {
      startD = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      endD = new Date(now.getFullYear(), now.getMonth(), 0);
    } else {
      endD = now;
      startD = new Date(now);
      startD.setDate(startD.getDate() - days);
    }
    table.setFilterValue('date', {
      start: formatDateInput(startD),
      end: formatDateInput(endD),
    });
  }

  return (
    <div className="space-y-3">
      <DataTableToolbar
        table={table}
        searchPlaceholder="搜尋備註、類別、金額、支付方式…"
        rightExtra={
          <BulkSettleDialog
            candidates={txs}
            trigger={
              <Button size="sm" variant="outline">
                <CreditCard className="size-4" /> 批次結算
              </Button>
            }
          />
        }
      />

      <div className="flex flex-wrap gap-1.5">
        {[
          { label: '本月', val: 'thisMonth' as const },
          { label: '上月', val: 'lastMonth' as const },
          { label: '近 7 天', val: 7 },
          { label: '近 30 天', val: 30 },
        ].map((c) => (
          <button
            key={String(c.val)}
            type="button"
            onClick={() => applyDateChip(c.val)}
            className="rounded-full border px-3 py-2 text-xs text-muted-foreground hover:bg-muted active:bg-muted md:px-2.5 md:py-1 md:text-[11px]"
          >
            {c.label}
          </button>
        ))}
      </div>

      {table.totalFiltered > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs tabular-nums">
          <span><span className="text-muted-foreground">我負擔</span> <span className="font-semibold">{formatCurrency(rangeTotal.share)}</span></span>
          {Math.abs(rangeTotal.expenseTotal - rangeTotal.share) > 0.5 ? (
            <span className="text-muted-foreground">整筆 {formatCurrency(rangeTotal.expenseTotal)}</span>
          ) : null}
          {Math.abs(rangeTotal.net) > 0.5 ? (
            <span className={rangeTotal.net > 0 ? 'text-success' : 'text-destructive'}>
              {rangeTotal.net > 0 ? '待收' : '待付'} {formatCurrency(Math.abs(rangeTotal.net))}
            </span>
          ) : null}
          <span className="text-muted-foreground">收入 {formatCurrency(rangeTotal.income)}</span>
          <span className="text-muted-foreground">{table.totalFiltered} 筆</span>
        </div>
      )}

      {truncated ? (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          已達單次載入上限 {RANGE_TX_LIMIT.toLocaleString()} 筆，較早的交易沒有載入；請用日期篩選縮小範圍。
        </div>
      ) : null}

      <TransactionList
        rows={table.rows}
        isLoading={isLoading}
        dayTotals={dayTotals}
        emptyHint={table.totalFiltered === 0 && (table.search || Object.keys(table.filterValues).length) ? '沒有符合條件的交易' : '點右下角 + 按鈕快速新增'}
      />

      <DataTablePagination table={table} />

      {!isLoading && !truncated ? (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1 text-[11px] text-muted-foreground">
          <span>已載入 {earliestKey.replace(/-/g, '/')} 起的 {txs.length} 筆交易</span>
          <Button size="sm" variant="ghost" className="h-9 gap-1 text-xs md:h-7" onClick={loadEarlier}>
            <History className="size-3.5" /> 載入更早 12 個月
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function uniquePaymentMethods(txs: Transaction[]): string[] {
  const set = new Set<string>();
  for (const t of txs) if (t.paymentMethod) set.add(t.paymentMethod);
  return Array.from(set).sort();
}
