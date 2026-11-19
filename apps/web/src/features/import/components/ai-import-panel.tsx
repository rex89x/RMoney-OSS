import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardPaste, Copy, FileJson, Loader2, RotateCcw, Sparkles, TrendingUp, Wallet, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn, formatCurrency } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import type { Account, AccountType } from '@/features/accounts';
import { PaymentSelect } from '@/features/ledger/components/payment-select';
import type { PaymentMethod } from '@/features/ledger/payment-methods';
import { useAiImport } from '../hooks';
import { LEDGER_ACCOUNT_TYPES, TRADE_ACCOUNT_TYPES, type ImportRow } from '../normalize';

const NO_ACCOUNT = '__none__';

function StepTitle({ index, title, done }: { index: number; title: string; done?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm font-semibold">
      <span className={cn('flex size-6 items-center justify-center rounded-full text-xs', done ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
        {done ? <CheckCircle2 className="size-4" /> : index}
      </span>
      {title}
    </div>
  );
}

/**
 * AI 匯入：任何 LLM 產出的 RMoney JSON → 預覽 → 寫入（記帳 + 股票成交）。
 * 兩條路：A. 複製提示詞到外部 AI（不花 API 費）；B. 站內 Claude（Apps Script parseImport）。
 */
export function AiImportPanel() {
  const s = useAiImport();
  const [mode, setMode] = useState<'external' | 'builtin'>('external');
  const selectedCount = s.rows.filter((r) => r.selected && r.status !== 'error').length;
  const errorCount = s.rows.filter((r) => r.status === 'error').length;
  const tradeCount = s.rows.filter((r) => r.selected && r.resolved.kind === 'trade').length;
  const ledgerAccounts = s.ctx.accounts.filter((a) => a.active !== false && !a.archivedAt && (LEDGER_ACCOUNT_TYPES as readonly string[]).includes(a.type));
  const paymentMethods = s.ctx.paymentMethods ?? [];
  const tradeAccounts = s.ctx.accounts.filter((a) => a.active !== false && !a.archivedAt && (TRADE_ACCOUNT_TYPES as readonly string[]).includes(a.type));
  const resultByKey = new Map((s.results ?? []).map((r) => [r.key, r]));

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(s.prompt);
      toast.success('已複製提示詞，貼到 ChatGPT / Claude / Gemini 後接著貼你的原始內容');
    } catch {
      toast.error('複製失敗，請手動選取下方文字');
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4" /> AI 匯入（記帳 / 股票成交）</CardTitle>
          <CardDescription>
            把券商成交通知、信用卡明細、收據文字或一段口語，交給任何 AI 轉成 RMoney 的通用 JSON，貼回來就能匯入。
            格式說明在 <code className="rounded bg-muted px-1">docs/AI_IMPORT_FORMAT.md</code>。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <StepTitle index={1} title="取得 JSON" done={s.jsonText.trim().length > 0} />
          <div className="grid grid-cols-2 gap-2 rounded-full bg-muted p-1 text-xs">
            <button type="button" onClick={() => setMode('external')} className={cn('h-8 rounded-full transition-colors', mode === 'external' ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}>
              用外部 AI（免 API 費）
            </button>
            <button type="button" onClick={() => setMode('builtin')} className={cn('h-8 rounded-full transition-colors', mode === 'builtin' ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}>
              站內 Claude 轉換
            </button>
          </div>

          {mode === 'external' ? (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">
                1. 按下面複製提示詞（已含你的類別、帳戶與支付方式名稱）→ 2. 貼到 ChatGPT / Claude / Gemini，接著貼上原始內容 → 3. 把它回的 JSON 貼到第 2 步。
                提示詞會要求模型用 ```json 圍欄輸出，用聊天介面的「複製」按鈕最保險；就算貼進來的是彎引號、單引號或少逗號，解析時也會自動修正。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => void copyPrompt()}><Copy className="size-3.5" /> 複製提示詞</Button>
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">看提示詞內容</summary>
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2 text-[11px]">{s.prompt}</pre>
              </details>
            </div>
          ) : (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">貼上原始內容（成交通知、明細、收據文字…），由 Apps Script 的 Claude 轉成 JSON（會計入 Claude 額度）。</p>
              <Textarea value={s.rawText} onChange={(e) => s.setRawText(e.target.value)} rows={6} placeholder="例：10/21 台積電 買進 1000 股 @ 1,050 手續費 150 …" />
              <Button size="sm" onClick={() => void s.convertWithClaude()} disabled={s.converting || !s.rawText.trim()}>
                {s.converting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} 用 Claude 轉換
              </Button>
            </div>
          )}

          <StepTitle index={2} title="貼上 JSON 並解析" done={s.rows.length > 0} />
          <Textarea
            value={s.jsonText}
            onChange={(e) => s.setJsonText(e.target.value)}
            rows={8}
            placeholder={'{"version":1,"items":[{"kind":"expense","date":"2026-10-23","amount":120,"currency":"TWD","category":"food","note":"午餐"}]}'}
            className="font-mono text-xs"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void s.parse()} disabled={s.parsing || !s.jsonText.trim()}>
              {s.parsing ? <Loader2 className="size-3.5 animate-spin" /> : <FileJson className="size-3.5" />} 解析預覽
            </Button>
            <Button size="sm" variant="ghost" onClick={s.reset} disabled={s.applying}><RotateCcw className="size-3.5" /> 清空</Button>
          </div>
          {s.parseError ? <p className="flex items-center gap-1 text-xs text-destructive"><XCircle className="size-3.5" /> {s.parseError}</p> : null}
          {!s.parseError && s.repaired ? (
            <p className="flex items-center gap-1 text-xs text-muted-foreground"><CheckCircle2 className="size-3.5" /> 貼進來的 JSON 有引號 / 逗號 / 括號問題，已自動修正後解析。</p>
          ) : null}
          {s.truncated ? (
            <p className="flex items-center gap-1 text-xs text-warning"><AlertTriangle className="size-3.5" /> 內容似乎被截斷（括號沒有收完），最後一筆已略過；請確認是否少貼了後半段。</p>
          ) : null}
          {s.rejected.length > 0 ? (
            <details className="text-xs text-warning">
              <summary className="cursor-pointer">{s.rejected.length} 筆格式不對已略過</summary>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {s.rejected.map((r) => <li key={r.index}>#{r.index + 1}：{r.message}</li>)}
              </ul>
            </details>
          ) : null}
        </CardContent>
      </Card>

      {s.rows.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StepTitle index={3} title={`確認並匯入（${selectedCount} / ${s.rows.length} 筆）`} done={Boolean(s.results)} />
              <Button size="sm" onClick={() => void s.apply()} disabled={s.applying || selectedCount === 0 || Boolean(s.results)}>
                {s.applying ? <Loader2 className="size-3.5 animate-spin" /> : <ClipboardPaste className="size-3.5" />} 匯入 {selectedCount} 筆
              </Button>
            </div>
            {errorCount > 0 ? <p className="text-xs text-destructive">{errorCount} 筆有錯誤不會匯入（看每列的說明）。</p> : null}
            {tradeCount > 0 ? <p className="text-xs text-muted-foreground">含 {tradeCount} 筆股票成交：會更新持倉與交割帳戶餘額，同一批成交請不要重複匯入。</p> : null}
            {s.applying ? <Progress value={s.progress.total > 0 ? (s.progress.done / s.progress.total) * 100 : 0} className="h-1.5" /> : null}
          </CardHeader>
          <CardContent>
            <ul className="divide-y rounded-xl border">
              {s.rows.map((row) => (
                <ImportRowView
                  key={row.key}
                  row={row}
                  result={resultByKey.get(row.key)}
                  categories={s.ctx.categories.filter((c) => c.type === (row.resolved.kind === 'income' ? 'income' : 'expense') && !c.archivedAt)}
                  accounts={row.resolved.kind === 'trade' ? tradeAccounts : ledgerAccounts}
                  paymentMethods={paymentMethods}
                  onToggle={(v) => s.toggleRow(row.key, v)}
                  onCategory={(v) => s.setRowCategory(row.key, v)}
                  onAccount={(v) => s.setRowAccount(row.key, v)}
                  onPayment={(v) => s.setRowPayment(row.key, v)}
                  disabled={s.applying || Boolean(s.results)}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/** 收入不能刷卡；支出可用所有記帳帳戶 */
function allowedTypesFor(kind: 'expense' | 'income'): AccountType[] {
  return kind === 'income'
    ? ['cash', 'bank', 'investment_cash', 'e_wallet_balance']
    : [...LEDGER_ACCOUNT_TYPES];
}

function ImportRowView({
  row, result, categories, accounts, paymentMethods, onToggle, onCategory, onAccount, onPayment, disabled,
}: {
  row: ImportRow;
  result: { outcome: 'created' | 'skipped' | 'failed'; message?: string } | undefined;
  categories: { key: string; name: string }[];
  accounts: Account[];
  paymentMethods: PaymentMethod[];
  onToggle: (v: boolean) => void;
  onCategory: (v: string) => void;
  onAccount: (v: string | null) => void;
  onPayment: (v: { paymentMethod: string; accountId: string | null }) => void;
  disabled: boolean;
}) {
  const r = row.resolved;
  const isTrade = r.kind === 'trade';
  const tone = row.status === 'error' ? 'text-destructive' : row.status === 'warn' ? 'text-warning' : 'text-muted-foreground';
  return (
    <li className={cn('space-y-2 p-3 text-sm', row.status === 'error' && 'bg-destructive/5', !row.selected && row.status !== 'error' && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-4 accent-primary"
          checked={row.selected}
          disabled={disabled || row.status === 'error'}
          onChange={(e) => onToggle(e.target.checked)}
          aria-label="匯入這筆"
        />
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
          {isTrade ? <TrendingUp className="size-4" /> : <Wallet className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={isTrade ? 'secondary' : r.kind === 'income' ? 'success' : 'outline'} className="h-5 text-[10px]">
              {isTrade ? (r.side === 'buy' ? '買進' : '賣出') : r.kind === 'income' ? '收入' : '支出'}
            </Badge>
            <span className="truncate font-medium">
              {isTrade ? `${r.symbol}（${r.market}） ${r.shares} 股 @ ${r.price}` : (r.note || '（無備註）')}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {formatTW(r.date, 'yyyy/MM/dd')}
            {isTrade ? (r.fee > 0 ? ` · 費用 ${r.currency} ${r.fee}` : '') : ` · ${r.paymentMethod}`}
          </div>
          {row.messages.length > 0 ? (
            <div className={cn('mt-1 flex items-start gap-1 text-[11px]', tone)}>
              <AlertTriangle className="mt-0.5 size-3 shrink-0" /> <span>{row.messages.join('；')}</span>
            </div>
          ) : null}
          {result ? (
            <div className={cn('mt-1 text-[11px]', result.outcome === 'failed' ? 'text-destructive' : result.outcome === 'skipped' ? 'text-muted-foreground' : 'text-success')}>
              {result.outcome === 'created' ? '已匯入' : result.outcome === 'skipped' ? `略過：${result.message ?? ''}` : `失敗：${result.message ?? ''}`}
            </div>
          ) : null}
        </div>
        <div className="shrink-0 text-right tabular-nums">
          <div className={cn('font-semibold', r.kind === 'income' && 'text-success')}>
            {isTrade ? `${r.currency} ${(r.shares * r.price).toLocaleString()}` : `${r.currency} ${r.amount.toLocaleString()}`}
          </div>
          {r.currency !== 'TWD' ? (
            <div className="text-[10px] text-muted-foreground">≈ {formatCurrency(isTrade ? r.grossTWD : r.amountTWD, 'TWD')}</div>
          ) : null}
        </div>
      </div>
      {!disabled ? (
        <div className="grid gap-2 pl-7 sm:grid-cols-2">
          {!isTrade ? (
            <div>
              <Label className="text-xs text-muted-foreground">{r.categoryGuessed ? '類別（自動放「其他」，請確認）' : '類別'}</Label>
              <Select value={r.categoryKey} onValueChange={onCategory}>
                <SelectTrigger className="mt-1 h-11"><SelectValue placeholder="類別" /></SelectTrigger>
                <SelectContent>
                  {categories.map((c) => <SelectItem key={c.key} value={c.key}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ) : <div />}
          {isTrade ? (
            <Select value={r.accountId ?? NO_ACCOUNT} onValueChange={(v) => onAccount(v === NO_ACCOUNT ? null : v)}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="交割帳戶" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ACCOUNT}>（未選交割帳戶）</SelectItem>
                {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : (
            // 與快速記帳同一個選擇器：自訂支付方式（信用卡…）+ 帳戶 + 預設；新增支付方式後這裡自動出現
            <PaymentSelect
              value={{ paymentMethod: r.paymentMethod, accountId: r.accountId ?? '' }}
              onChange={(next) => onPayment({ paymentMethod: next.paymentMethod, accountId: next.accountId || null })}
              accounts={accounts}
              customPMs={paymentMethods}
              allowedAccountTypes={allowedTypesFor(r.kind)}
              label={r.paymentMatched ? '付款方式' : '付款方式（來源沒指定或對不到，請確認）'}
              showAccountLabel={r.kind === 'income' ? '入帳帳戶' : '扣款帳戶'}
            />
          )}
        </div>
      ) : null}
    </li>
  );
}
