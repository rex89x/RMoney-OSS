import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Upload, Link2, EyeOff, AlertTriangle, CheckCircle2, Inbox, CloudDownload, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn, formatCurrency } from '@/lib/utils';
import { useCategories } from '@/features/ledger/hooks';
import { usePaymentMethods } from '@/features/ledger/payment-methods';
import { PaymentSelect, type PaymentSelection } from '@/features/ledger/components/payment-select';
import { useAccounts } from '@/features/accounts';
import { DEFAULT_PAYMENT_METHODS } from '@/lib/seed-data';
import { decodeInvoiceFile, parseEInvoiceText, type EInvoiceRecord } from '../parser';
import type { InvoiceRow, InvoiceRowStatus } from '../match';
import { useIgnoreInvoices, useImportInvoices, useInvoiceRows, useLinkInvoices } from '../hooks';
import { callAppsScript } from '@/lib/apps-script';
import { useQueryClient } from '@tanstack/react-query';

const STATUS_LABEL: Record<InvoiceRowStatus, { text: string; variant: 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive' }> = {
  new: { text: '新的', variant: 'default' },
  likely: { text: '可能已記', variant: 'warning' },
  linked: { text: '已匯入', variant: 'success' },
  void: { text: '作廢', variant: 'destructive' },
  ignored: { text: '已忽略', variant: 'outline' },
};

interface SyncResult { created?: number; skipped?: number; uncategorized?: number; totalTWD?: number; fetched?: number; error?: string }

function AutoSyncCard() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState('7');
  const [last, setLast] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    try {
      const res = await callAppsScript<SyncResult>('syncEInvoices', { daysBack: days });
      if (!res.ok) {
        const msg = typeof res.error === 'string' ? res.error : '同步失敗';
        setLast(msg);
        toast.error(msg.includes('not set') ? '尚未設定 EINVOICE_* Script Properties' : msg);
        return;
      }
      const created = Number(res.created ?? 0);
      const skipped = Number(res.skipped ?? 0);
      const unc = Number(res.uncategorized ?? 0);
      setLast(`匯入 ${created} 張（略過 ${skipped}，待分類 ${unc}），合計 ${formatCurrency(Number(res.totalTWD ?? 0))}`);
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      toast.success(created > 0 ? `已匯入 ${created} 張發票` : '沒有新的發票');
    } catch (err) {
      console.error('[syncEInvoices]', err);
      toast.error(err instanceof Error ? err.message : '同步失敗');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><CloudDownload className="size-4" /> 自動同步（財政部 API）</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          每日 01:00 自動抓近 7 天手機條碼載具的發票，同號不重複；猜不到類別的會進「需要處理」。
          需要在 Apps Script 的 Script Properties 設定 <code className="text-[11px]">EINVOICE_APP_ID</code>、
          <code className="text-[11px]">EINVOICE_CARD_NO</code>、<code className="text-[11px]">EINVOICE_CARD_ENCRYPT</code>（選填 <code className="text-[11px]">EINVOICE_PAYMENT_METHOD</code>）。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="h-9 w-28 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {['3', '7', '14', '30', '60'].map((d) => <SelectItem key={d} value={d}>近 {d} 天</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => void run()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <CloudDownload className="size-4" />} 立即同步
          </Button>
          {last ? <span className="text-xs text-muted-foreground">{last}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function EInvoiceImportPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [records, setRecords] = useState<EInvoiceRecord[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [categoryOverride, setCategoryOverride] = useState<Record<string, string>>({});
  const [payment, setPayment] = useState<PaymentSelection>({ paymentMethod: DEFAULT_PAYMENT_METHODS[0] ?? '現金', accountId: '' });

  const { rows, defaultCategory, isLoading } = useInvoiceRows(records);
  const { data: categories = [] } = useCategories();
  const { data: customPMs = [] } = usePaymentMethods();
  const { data: accounts = [] } = useAccounts();
  const importMut = useImportInvoices();
  const linkMut = useLinkInvoices();
  const ignoreMut = useIgnoreInvoices();
  const busy = importMut.isPending || linkMut.isPending || ignoreMut.isPending;

  const expenseCats = useMemo(() => categories.filter((c) => c.type === 'expense' && !c.archivedAt), [categories]);

  const counts = useMemo(() => {
    const c: Record<InvoiceRowStatus, number> = { new: 0, likely: 0, linked: 0, void: 0, ignored: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = await decodeInvoiceFile(f);
      const res = parseEInvoiceText(text);
      if (res.records.length === 0) {
        toast.error(res.errors[0] ?? '沒有解析到任何發票');
      }
      res.records.sort((a, b) => b.date.getTime() - a.date.getTime());
      setRecords(res.records);
      setParseErrors(res.errors);
      setFileName(f.name);
      setCategoryOverride({});
      setSelected(new Set(res.records.filter((r) => r.status !== 'void').map((r) => r.invoiceNumber)));
    } catch (err) {
      console.error('[einvoice.onFile]', err);
      toast.error(err instanceof Error ? err.message : '讀取檔案失敗');
    } finally {
      e.target.value = '';
    }
  }

  function toggle(no: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(no)) next.delete(no); else next.add(no);
      return next;
    });
  }

  const actionable = rows.filter((r) => (r.status === 'new' || r.status === 'likely') && selected.has(r.record.invoiceNumber));
  const toImport = actionable.filter((r) => r.status === 'new');
  const toLink = actionable.filter((r) => r.status === 'likely' && r.matchTx);

  async function handleImport() {
    if (toImport.length === 0) return;
    const res = await importMut.mutateAsync(toImport.map((r) => ({
      record: r.record,
      category: categoryOverride[r.record.invoiceNumber] ?? defaultCategory(r.record),
      paymentMethod: payment.paymentMethod,
      fromAccountId: payment.accountId || null,
    })));
    if (res.created > 0) {
      setSelected((prev) => {
        const next = new Set(prev);
        toImport.forEach((r) => { if (!res.failed.includes(r.record.invoiceNumber)) next.delete(r.record.invoiceNumber); });
        return next;
      });
    }
  }

  async function handleLink() {
    if (toLink.length === 0) return;
    await linkMut.mutateAsync(toLink.map((r) => ({ tx: r.matchTx!, invoiceNumber: r.record.invoiceNumber })));
    setSelected((prev) => {
      const next = new Set(prev);
      toLink.forEach((r) => next.delete(r.record.invoiceNumber));
      return next;
    });
  }

  async function handleIgnore() {
    if (actionable.length === 0) return;
    await ignoreMut.mutateAsync(actionable.map((r) => r.record.invoiceNumber));
    setSelected((prev) => {
      const next = new Set(prev);
      actionable.forEach((r) => next.delete(r.record.invoiceNumber));
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <AutoSyncCard />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><FileText className="size-4" /> 手動匯入檔案</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            支援財政部「電子發票整合服務平台 → 載具消費紀錄」下載檔（M / D 列、Big5 或 UTF-8），
            以及任何含「發票號碼、日期、金額」欄位的 CSV（發票存摺等）。
            同一發票號碼只會匯入一次；同日同金額已有交易會標成「可能已記」讓你連結而不是重複建立。
            猜不到類別的會歸到「其他」，之後會出現在「需要處理」。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept=".csv,.txt" onChange={(e) => void onFile(e)} className="hidden" />
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
              <Upload className="size-4" /> 選取發票檔
            </Button>
            {fileName ? <span className="text-xs text-muted-foreground">{fileName} · {records.length} 張</span> : null}
          </div>
          {parseErrors.length > 0 ? (
            <details className="text-xs text-destructive">
              <summary className="flex cursor-pointer items-center gap-1"><AlertTriangle className="size-3" /> {parseErrors.length} 行解析問題</summary>
              <ul className="mt-1 list-disc pl-4">{parseErrors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}</ul>
            </details>
          ) : null}
        </CardContent>
      </Card>

      {records.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
              <span className="flex flex-wrap items-center gap-1.5">
                比對結果
                {(Object.keys(counts) as InvoiceRowStatus[]).filter((k) => counts[k] > 0).map((k) => (
                  <Badge key={k} variant={STATUS_LABEL[k].variant} className="font-normal">{STATUS_LABEL[k].text} {counts[k]}</Badge>
                ))}
              </span>
              {counts.linked > 0 || counts.new === 0 ? (
                <Button size="sm" variant="ghost" asChild>
                  <Link to="/inbox"><Inbox className="size-3.5" /> 需要處理</Link>
                </Button>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading ? <Skeleton className="h-24 w-full" /> : null}

            <div className="rounded-xl border p-3">
              <PaymentSelect
                value={payment}
                onChange={setPayment}
                accounts={accounts}
                customPMs={customPMs}
                allowedAccountTypes={['cash', 'bank', 'credit_card', 'e_wallet_balance']}
                label="這批發票的支付方式"
                showAccountLabel="扣款帳戶"
                emptyHint="沒有對應帳戶也可以匯入，只是餘額不會扣。"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void handleImport()} disabled={busy || toImport.length === 0}>
                <CheckCircle2 className="size-4" /> 匯入 {toImport.length} 筆新的
              </Button>
              <Button variant="outline" onClick={() => void handleLink()} disabled={busy || toLink.length === 0}>
                <Link2 className="size-4" /> 連結 {toLink.length} 筆已記過的
              </Button>
              <Button variant="ghost" onClick={() => void handleIgnore()} disabled={busy || actionable.length === 0}>
                <EyeOff className="size-4" /> 忽略勾選 {actionable.length} 筆
              </Button>
            </div>

            <ul className="divide-y rounded-xl border">
              {rows.map((row) => (
                <InvoiceRowItem
                  key={row.record.invoiceNumber}
                  row={row}
                  checked={selected.has(row.record.invoiceNumber)}
                  onToggle={() => toggle(row.record.invoiceNumber)}
                  category={categoryOverride[row.record.invoiceNumber] ?? defaultCategory(row.record)}
                  onCategory={(v) => setCategoryOverride((prev) => ({ ...prev, [row.record.invoiceNumber]: v }))}
                  categories={expenseCats}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

interface RowProps {
  row: InvoiceRow;
  checked: boolean;
  onToggle: () => void;
  category: string;
  onCategory: (v: string) => void;
  categories: { key: string; name: string }[];
}

function InvoiceRowItem({ row, checked, onToggle, category, onCategory, categories }: RowProps) {
  const { record, status, matchTx } = row;
  const actionable = status === 'new' || status === 'likely';
  const label = STATUS_LABEL[status];
  return (
    <li className={cn('flex items-start gap-3 px-3 py-2.5', !actionable && 'opacity-60')}>
      <input
        type="checkbox"
        className="mt-1 size-4 accent-primary"
        checked={actionable && checked}
        disabled={!actionable}
        onChange={onToggle}
        aria-label="選取"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{record.sellerName || record.items[0] || record.invoiceNumber}</span>
          <span className="shrink-0 text-sm tabular-nums">{formatCurrency(record.amount)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{record.dateKey}</span>
          <span className="font-mono">{record.invoiceNumber}</span>
          <Badge variant={label.variant} className="h-4 px-1.5 text-[10px] font-normal">{label.text}</Badge>
          {status === 'likely' && matchTx ? (
            <span className="truncate">→ {matchTx.note || matchTx.category} · {matchTx.paymentMethod}</span>
          ) : null}
        </div>
        {record.items.length > 0 ? (
          <div className="truncate text-[11px] text-muted-foreground">{record.items.slice(0, 5).join('、')}{record.items.length > 5 ? '…' : ''}</div>
        ) : null}
      </div>
      {status === 'new' ? (
        <Select value={category} onValueChange={onCategory}>
          <SelectTrigger className="h-8 w-[7.5rem] shrink-0 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {categories.map((c) => <SelectItem key={c.key} value={c.key}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : null}
    </li>
  );
}
