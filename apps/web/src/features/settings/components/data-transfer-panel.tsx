import { useMemo, useRef, useState } from 'react';
import { Download, Upload, FileJson, FileSpreadsheet, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { downloadText, parseCsv, toCsv } from '@/lib/csv';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AccountSelect } from '@/features/accounts';
import {
  STATEMENT_FIELD_LABEL, decodeStatementFile, guessMapping, mapStatementRows,
  type SignConvention, type StatementField, type StatementMapping,
} from '@/features/import/statement-mapping';
import { useAuth } from '@/hooks/use-auth';
import { useQueryClient } from '@tanstack/react-query';
import { bulkCreateTransactions, listTransactions } from '@/features/ledger/api';
import { dedupeImportRows } from '@/features/ledger/import-dedupe';
import { useAccounts, type Account } from '@/features/accounts';
import type { TransactionInput } from '@/features/ledger/types';
import { useTransactions, useCategories } from '@/features/ledger/hooks';
import { useFxRates } from '@/features/fx/hooks';
import type { Currency } from '@/types/global';
import { formatTW, formatTWDateInput, fromTW, nowTW } from '@/lib/tz';

type CsvRow = Record<string, string | undefined>;

const MAPPING_FIELDS: StatementField[] = ['date', 'amount', 'debit', 'credit', 'type', 'note', 'category', 'paymentMethod', 'currency', 'tripId'];
const NONE = '__none__';
const MAPPING_STORAGE_PREFIX = 'personal-hub:csv-mapping:';

/** 同一家銀行的匯出檔欄名固定，記住上次的對應（每台裝置各自記，localStorage 失敗就算了） */
function loadSavedMapping(headers: string[]): StatementMapping | null {
  try {
    const raw = window.localStorage.getItem(MAPPING_STORAGE_PREFIX + headers.join('|'));
    return raw ? (JSON.parse(raw) as StatementMapping) : null;
  } catch {
    return null;
  }
}
function saveMapping(headers: string[], mapping: StatementMapping): void {
  try {
    window.localStorage.setItem(MAPPING_STORAGE_PREFIX + headers.join('|'), JSON.stringify(mapping));
  } catch (err) {
    console.warn('[saveMapping]', err);
  }
}

export function DataTransferPanel() {
  const { user, profile } = useAuth();
  const qc = useQueryClient();
  const oneYearAgo = useMemo(() => {
    const d = nowTW();
    d.setFullYear(d.getFullYear() - 1);
    return fromTW(d);
  }, []);
  const { data: txs = [] } = useTransactions({ startDate: oneYearAgo, limit: 2000 });
  const { data: rates = [] } = useFxRates();
  const { data: categories = [] } = useCategories();
  const { data: accounts = [] } = useAccounts();
  // CSV 的 paymentMethod 對得到帳戶（名稱或舊支付方式名稱）時，匯入會一併調整該帳戶餘額
  const accountByPaymentMethod = useMemo(() => {
    const map = new Map<string, Account>();
    for (const a of accounts) {
      if (a.active === false || a.archivedAt) continue;
      for (const name of [a.name, a.legacyPaymentMethod]) {
        const key = String(name ?? '').trim().toLowerCase();
        if (key && !map.has(key)) map.set(key, a);
      }
    }
    return map;
  }, [accounts]);

  const [rawRows, setRawRows] = useState<CsvRow[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<StatementMapping | null>(null);
  const [sign, setSign] = useState<SignConvention>('negativeIsExpense');
  // 整份對帳單屬於哪個帳戶（銀行 / 信用卡匯出檔通常是單一帳戶）；選了就套到沒有支付方式的列並調整該帳戶餘額
  const [statementAccountId, setStatementAccountId] = useState('');
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const mapped = useMemo(
    () => (mapping ? mapStatementRows(rawRows, mapping, sign) : { rows: [], errors: [] }),
    [rawRows, mapping, sign],
  );
  const preview = mapped.rows;
  const singleAmountColumn = !!mapping && !mapping.debit && !mapping.credit && !mapping.type;
  const statementAccount = accounts.find((a) => a.id === statementAccountId) ?? null;

  function resetImport() {
    setRawRows([]); setHeaders([]); setMapping(null); setParseErrors([]); setErrors([]); setStatementAccountId('');
  }
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function exportTxCsv() {
    if (txs.length === 0) return toast.info('沒有資料可匯出');
    const rows = txs.map((t) => ({
      date: t.date.toISOString(),
      type: t.type,
      amount: t.amount,
      currency: t.currency,
      amountTWD: t.amountTWD,
      fxRate: t.fxRate,
      category: t.category,
      paymentMethod: t.paymentMethod,
      note: t.note ?? '',
      tripId: t.tripId ?? '',
    }));
    downloadText(
      `transactions-${formatTWDateInput(new Date())}.csv`,
      toCsv(rows),
    );
    toast.success(`已匯出 ${rows.length} 筆交易 CSV`);
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = await decodeStatementFile(f);
      const { rows, errors } = parseCsv<CsvRow>(text);
      const hs = rows[0] ? Object.keys(rows[0]) : [];
      if (hs.length === 0) { toast.error('讀不到欄位，確認首列是標題列'); return; }
      setRawRows(rows);
      setHeaders(hs);
      setMapping(loadSavedMapping(hs) ?? guessMapping(hs));
      setParseErrors(errors);
      setErrors([]);
    } catch (err) {
      console.error('[DataTransferPanel.onFileChange]', err);
      toast.error(err instanceof Error ? err.message : '讀取 CSV 失敗');
    } finally {
      e.target.value = ''; // 讓同一檔再選也能觸發
    }
  }

  async function doImport() {
    if (!user) return;
    setImporting(true);
    try {
      if (!mapping) return;
      const prepared: TransactionInput[] = [];
      const skipRows: string[] = [...mapped.errors];
      for (const r of preview) {
        const currency = r.currency as Currency;
        const fxRate = currency === 'TWD' ? 1
          : (rates.find((x) => x.base === currency && x.quote === 'TWD')?.rate ?? NaN);
        if (!Number.isFinite(fxRate)) { skipRows.push(`${formatTW(r.date, 'yyyy-MM-dd')} ${r.note ?? ''}：沒有 ${currency} 匯率`); continue; }
        const paymentMethod = r.paymentMethod ?? statementAccount?.legacyPaymentMethod ?? statementAccount?.name ?? '其他';
        const account = (r.paymentMethod ? accountByPaymentMethod.get(r.paymentMethod.trim().toLowerCase()) : null) ?? statementAccount;
        const category = r.category && categories.some((c) => c.key === r.category)
          ? r.category
          : (r.type === 'income' ? 'other_income' : 'other');
        prepared.push({
          userId: user.uid,
          type: r.type,
          amount: r.amount,
          currency,
          amountTWD: r.amount * fxRate,
          fxRate,
          category,
          paymentMethod,
          fromAccountId: r.type === 'expense' ? account?.id ?? null : null,
          toAccountId: r.type === 'income' && account?.type !== 'credit_card' ? account?.id ?? null : null,
          note: r.note ?? undefined,
          date: r.date,
          tripId: r.tripId || null,
          tags: ['csv-import'],
        });
      }
      if (prepared.length === 0) {
        toast.error('沒有可匯入的有效資料');
        setErrors(skipRows);
        return;
      }
      // 去重：查 CSV 日期範圍內的既有交易（同日 + 類型 + 金額 + 幣別 + 備註），重複匯入同一份檔案不會重複入帳
      const times = prepared.map((p) => p.date.getTime());
      const existing = await listTransactions({
        userId: user.uid,
        startDate: new Date(Math.min(...times) - 24 * 3600 * 1000),
        endDate: new Date(Math.max(...times) + 24 * 3600 * 1000),
        limit: 10000,
      });
      const { fresh, duplicates } = dedupeImportRows(prepared, existing);
      if (fresh.length === 0) {
        toast.info(`${duplicates.length} 筆都已存在，沒有新增`);
        resetImport();
        setErrors(skipRows);
        return;
      }
      const n = await bulkCreateTransactions(fresh, user.uid);
      const withAccount = fresh.filter((p) => p.fromAccountId || p.toAccountId).length;
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      const notes = [
        duplicates.length ? `${duplicates.length} 筆已存在略過` : '',
        skipRows.length ? `${skipRows.length} 筆格式錯誤略過` : '',
        withAccount ? `${withAccount} 筆已同步調整帳戶餘額` : '',
      ].filter(Boolean).join('、');
      toast.success(`已匯入 ${n} 筆交易${notes ? `（${notes}）` : ''}`);
      saveMapping(headers, mapping);
      resetImport();
      setErrors(skipRows);
    } catch (err) {
      console.error('[DataTransferPanel.doImport]', err);
      toast.error(err instanceof Error ? err.message : '匯入失敗');
    } finally {
      setImporting(false);
    }
  }

  function exportBackup() {
    const bundle = {
      exportedAt: new Date().toISOString(),
      appVersion: '1.0',
      user: { email: profile?.email, uid: user?.uid },
      transactions: txs.map((t) => ({ ...t, date: t.date.toISOString() })),
      fxRates: rates.map((r) => ({ ...r, updatedAt: r.updatedAt?.toISOString() ?? null })),
      categories,
    };
    downloadText(
      `personal-hub-backup-${formatTWDateInput(new Date())}.json`,
      JSON.stringify(bundle, null, 2),
      'application/json',
    );
    toast.success('已匯出完整備份 JSON');
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="size-4" /> CSV 匯入/匯出（交易）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            支援本 app 匯出的 CSV，也支援銀行 / 信用卡對帳單：選檔後會自動辨識欄位（交易日期、摘要、支出 / 存入…，
            民國年與 Big5 編碼都可以），不對的話在下方調整，設定會記住。重複匯入同一份檔案不會重複入帳。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={exportTxCsv}>
              <Download className="size-4" /> 匯出 CSV
            </Button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFileChange} className="hidden" />
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload className="size-4" /> 選取 CSV 檔
            </Button>
          </div>

          {mapping && headers.length > 0 ? (
            <div className="space-y-3 rounded-md border p-3">
              <div className="text-sm font-medium">欄位對應</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {MAPPING_FIELDS.map((f) => (
                  <div key={f} className="flex items-center gap-2">
                    <Label className="w-28 shrink-0 text-xs text-muted-foreground">{STATEMENT_FIELD_LABEL[f]}</Label>
                    <Select
                      value={mapping[f] ?? NONE}
                      onValueChange={(v) => setMapping({ ...mapping, [f]: v === NONE ? null : v })}
                    >
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>（不使用）</SelectItem>
                        {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              {singleAmountColumn ? (
                <div className="flex items-center gap-2">
                  <Label className="w-28 shrink-0 text-xs text-muted-foreground">金額正負號</Label>
                  <Select value={sign} onValueChange={(v) => setSign(v as SignConvention)}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="negativeIsExpense">負數 = 支出（銀行帳戶常見）</SelectItem>
                      <SelectItem value="positiveIsExpense">正數 = 支出（信用卡帳單常見）</SelectItem>
                      <SelectItem value="allExpense">全部視為支出</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {!mapping.paymentMethod ? (
                <div>
                  <Label className="text-xs text-muted-foreground">這份對帳單屬於哪個帳戶（選填，會同步調整該帳戶餘額）</Label>
                  <AccountSelect
                    value={statementAccountId}
                    onValueChange={setStatementAccountId}
                    accounts={accounts.filter((a) => a.active !== false && !a.archivedAt)}
                    placeholder="不指定"
                  />
                </div>
              ) : null}
              {preview.length === 0 ? (
                <p className="text-xs text-destructive">目前的對應讀不到任何一列，請確認日期與金額欄位。</p>
              ) : null}
              {parseErrors.length > 0 ? (
                <p className="text-xs text-muted-foreground">CSV 格式警告 {parseErrors.length} 則（通常是空白列或欄數不一致）</p>
              ) : null}
            </div>
          ) : null}

          {preview.length > 0 && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  預覽 · {preview.length} 筆
                  {mapped.errors.length > 0 && (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs text-destructive">
                      <AlertTriangle className="size-3" /> {mapped.errors.length} 列略過
                    </span>
                  )}
                </span>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={resetImport}>
                    取消
                  </Button>
                  <Button size="sm" onClick={() => void doImport()} disabled={importing}>
                    匯入
                  </Button>
                </div>
              </div>
              <div className="max-h-48 overflow-auto text-xs">
                <table className="w-full">
                  <thead><tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-2">日期</th>
                    <th className="py-1 pr-2">收支</th>
                    <th className="py-1 pr-2">金額</th>
                    <th className="py-1 pr-2">幣別</th>
                    <th className="py-1 pr-2">類別</th>
                    <th className="py-1 pr-2">備註</th>
                  </tr></thead>
                  <tbody>
                    {preview.slice(0, 50).map((r, i) => (
                      <tr key={i} className="border-t">
                        <td className="py-1 pr-2 whitespace-nowrap">{formatTW(r.date, 'yyyy-MM-dd')}</td>
                        <td className="py-1 pr-2">{r.type === 'income' ? '收入' : '支出'}</td>
                        <td className="py-1 pr-2 tabular-nums">{r.amount}</td>
                        <td className="py-1 pr-2">{r.currency}</td>
                        <td className="py-1 pr-2">{r.category ?? '—'}</td>
                        <td className="py-1 pr-2 truncate">{r.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {mapped.errors.length > 0 && (
                <details className="text-xs text-destructive">
                  <summary>略過的列</summary>
                  <ul className="ml-4 list-disc">
                    {mapped.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </details>
              )}
            </div>
          )}
          {preview.length === 0 && errors.length > 0 ? (
            <details className="text-xs text-destructive">
              <summary>上次匯入略過 {errors.length} 筆</summary>
              <ul className="ml-4 list-disc">
                {errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </details>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileJson className="size-4" /> 完整備份（JSON）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            下載目前可見的交易、匯率、類別設定為單一 JSON。可作為異地備份。
          </p>
          <Button onClick={exportBackup}>
            <Download className="size-4" /> 下載完整備份
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
