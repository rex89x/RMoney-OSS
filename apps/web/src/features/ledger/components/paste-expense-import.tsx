import { AlertTriangle, ArrowRight, CheckCircle2, ClipboardPaste, Copy, Loader2, Plus, RotateCcw, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { CATEGORY_HINT_NAME, IMPORT_MODE_LABEL, PERSON_NAME, type ImportMode } from '../paste-import-plan';
import { NO_TRIP, usePasteExpenseImport, type PreviewRow } from '../use-paste-expense-import';

function modeHint(mode: ImportMode, partner: string): string {
  switch (mode) {
    case 'household': return `依巧明日常的分攤記進共同帳本；你付的扣你的帳戶，${partner}付的只記欠款。`;
    case 'loan': return `兩人分攤的費用只記你那一半（依巧明日常的分攤）。你先付：帳戶扣全額、${partner}欠你一半；${partner}先付：不扣帳戶、你欠${partner}一半。欠款在「代墊」分頁結清；只有你參與的費用才記全額。`;
  }
}

function modeLabel(mode: ImportMode, partner: string): string {
  return mode === 'loan' ? `代墊・跟${partner}分攤` : IMPORT_MODE_LABEL[mode];
}

function twd(value: number): string {
  return `NT$${Math.round(value).toLocaleString('zh-TW')}`;
}

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

function FieldSelect({ label, value, placeholder, options, onChange, invalid }: {
  label: string;
  value: string;
  placeholder: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  invalid?: boolean;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      {label ? <span className="text-muted-foreground">{label}</span> : null}
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger aria-label={label || placeholder} className={cn(invalid && 'border-destructive')}><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>
          {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </label>
  );
}

function RowStatus({ row }: { row: PreviewRow }) {
  if (row.result) {
    return <Badge variant="success">{row.result.status === 'created' ? '已入帳' : '先前已匯入'}</Badge>;
  }
  if (row.error) return <Badge variant="destructive">失敗</Badge>;
  if (!row.plan.ok) return <Badge variant={row.plan.skipped ? 'secondary' : 'warning'}>{row.plan.skipped ? '略過' : '待補'}</Badge>;
  if (row.similar) return <Badge variant="warning">疑似重複</Badge>;
  return null;
}

function shareDetail(amount: number, paidBy: 'chiau' | 'ming', myShare: number, charged: number): string {
  const partner = PERSON_NAME.chiau;
  if (myShare === amount) return `全額記你的花費${charged > 0 ? ` · 帳戶扣 ${twd(charged)}` : ''}`;
  if (paidBy === 'ming') return `記你的一份 ${twd(myShare)} · 帳戶扣 ${twd(charged)} · ${partner}欠你 ${twd(amount - myShare)}`;
  return `${partner}先付 · 不扣你的帳戶 · 你欠${partner} ${twd(myShare)}`;
}

function PreviewRowItem({ row, busy, onToggle, categoryName, groupName }: {
  row: PreviewRow;
  busy: boolean;
  onToggle: (include: boolean) => void;
  categoryName: string;
  /** 一次貼了好幾趟旅程時才顯示來源旅程名稱。 */
  groupName?: string;
}) {
  const { item, plan } = row;
  const selectable = plan.ok && !row.result;
  const detail = row.error
    ?? (!plan.ok ? plan.reason
      : row.similar && !row.selected ? 'RMoney 已有同日同額同備註的交易，確認不是重複再勾選'
        : shareDetail(item.amount, item.paidByHint, plan.myShareTWD, plan.chargedTWD));
  const split = plan.ok && plan.myShareTWD !== item.amount;
  return (
    <li className={cn('flex items-start gap-3 px-3 py-2.5', !selectable && !row.result && 'opacity-70')}>
      <input
        type="checkbox"
        className="mt-1 size-4 shrink-0 accent-primary"
        aria-label={`匯入 ${item.note}`}
        checked={row.selected}
        disabled={!selectable || busy}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{item.note}</span>
          {/* 右邊的數字是「記進你花費的金額」；分攤時是一半，總額放在旁邊對照。 */}
          <span className="shrink-0 text-right tabular-nums">
            <span className="text-sm font-semibold">{twd(plan.ok ? plan.myShareTWD : item.amount)}</span>
            {split ? <span className="block text-[11px] text-muted-foreground">總額 {twd(item.amount)}</span> : null}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="tabular-nums">{item.date.slice(5).replace('-', '/')}</span>
          <span>{PERSON_NAME[item.paidByHint]}付款</span>
          <span>{categoryName}</span>
          {groupName ? <span>{groupName}</span> : null}
          <RowStatus row={row} />
        </div>
        <p className={cn('mt-0.5 text-xs', row.error ? 'text-destructive' : !plan.ok && !plan.skipped ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>{detail}</p>
      </div>
    </li>
  );
}

export function PasteExpenseImport() {
  const { isOwner } = useAuth();
  const s = usePasteExpenseImport();

  if (!isOwner) {
    return <p className="text-sm text-muted-foreground">只有 RMoney 帳戶 owner 可以使用會調整帳戶餘額的貼上匯入。</p>;
  }

  const categoryOptions = s.expenseCategories.map((category) => ({ value: category.key, label: category.name }));
  const categoryName = (key: string) => s.expenseCategories.find((category) => category.key === key)?.name ?? '未選類別';
  const missingCategory = s.hints.some((hint) => !s.categoryMap[hint]);
  const allDone = s.transfer !== null && s.rows.length > 0 && s.rows.every((row) => row.result || !row.plan.ok);

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-lg"><ClipboardPaste className="size-5" />匯入巧明日常費用</CardTitle>
        <CardDescription>在巧明日常旅程的「費用」按「複製到 RMoney」，回到這裡貼上。確認前不會新增任何交易。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 1. 貼上 */}
        <section className="space-y-3">
          <StepTitle index={1} title="貼上資料" done={s.transfer !== null} />
          {s.transfer ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
              <span>
                <span className="font-medium">{s.transfer.items.length} 筆{s.targetKind === 'trip' ? '旅程支出' : '一般支出'}</span>
                <span className="text-muted-foreground"> · {twd(s.transfer.items.reduce((sum, item) => sum + item.amount, 0))}{s.tripGroups.length > 1 ? ` · ${s.tripGroups.length} 趟旅程` : ''}</span>
              </span>
              <Button variant="ghost" size="sm" onClick={s.reset} disabled={s.busy}><RotateCcw className="size-4" />重新貼上</Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void s.pasteFromClipboard()}><ClipboardPaste className="size-4" />從剪貼簿貼上</Button>
              </div>
              <textarea
                className="min-h-24 w-full rounded-md border bg-background p-3 font-mono text-xs"
                aria-label="貼上巧明日常費用資料"
                placeholder="或長按這裡貼上"
                value={s.text}
                onChange={(event) => s.setText(event.target.value)}
              />
              {s.parsing ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />解析中…</p> : null}
              {s.parseError ? <p className="flex items-center gap-2 text-sm text-destructive" role="alert"><AlertTriangle className="size-4 shrink-0" />{s.parseError}</p> : null}
            </>
          )}
        </section>

        {s.transfer ? (
          <>
            {/* 2. 設定（都有預設值，會記住上次的選擇） */}
            <section className="space-y-3">
              <StepTitle index={2} title="確認記帳方式" done={s.summary.blocked === 0 && !s.needsAccount} />
              <div role="radiogroup" aria-label="記帳方式" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {s.modes.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={s.mode === mode}
                    disabled={s.busy}
                    onClick={() => s.setMode(mode)}
                    className={cn(
                      'rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                      s.mode === mode ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-muted',
                    )}
                  >
                    {modeLabel(mode, s.counterpartyName || '對方')}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{modeHint(s.mode, s.counterpartyName || '對方')}</p>

              <div className="grid gap-3 sm:grid-cols-2">
                <FieldSelect
                  label="你付的費用從哪個帳戶扣"
                  value={s.account?.id ?? ''}
                  placeholder="選擇付款帳戶"
                  options={s.myAccounts.map((account) => ({ value: account.id, label: account.name }))}
                  onChange={s.setAccountId}
                  invalid={s.needsAccount}
                />
                {s.mode === 'loan' ? (
                  <label className="grid gap-1.5 text-sm">
                    <span className="text-muted-foreground">代墊對象（「代墊」分頁以這個名字累計）</span>
                    <Input value={s.counterpartyName} onChange={(event) => s.setCounterpartyName(event.target.value)} aria-invalid={!s.counterpartyName.trim()} />
                  </label>
                ) : null}
              </div>

              {s.tripGroups.length > 0 ? (
                <div className="space-y-2 rounded-lg border p-3">
                  <p className="text-sm font-medium">歸屬 RMoney 旅程</p>
                  {s.tripGroups.map((group) => (
                    <div key={group.sourceTripKey} className="space-y-2">
                      <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                        <div className="text-sm">
                          <span className="font-medium">{group.nameHint || '未命名旅程'}</span>
                          <span className="text-muted-foreground"> · {group.items.length} 筆</span>
                        </div>
                        <FieldSelect
                          label=""
                          value={group.choice}
                          placeholder="選擇 RMoney 旅程"
                          options={[
                            ...s.trips.map((trip) => ({ value: trip.id, label: trip.name })),
                            { value: NO_TRIP, label: '不歸屬旅程（只記花費）' },
                          ]}
                          onChange={(value) => s.setTripChoice(group.sourceTripKey, value)}
                          invalid={!group.choice}
                        />
                      </div>
                      {!group.choice ? (
                        <Button variant="outline" size="sm" disabled={s.creatingTrip} onClick={() => void s.createTripFor(group)}>
                          <Plus className="size-4" />在 RMoney 建立「{group.nameHint || '巧明日常旅程'}」
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}

              <details className="group rounded-lg border" open={missingCategory}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-sm">
                  <span className="font-medium">類別對應</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {missingCategory ? '有類別需要選擇' : s.hints.map((hint) => `${CATEGORY_HINT_NAME[hint]}→${categoryName(s.categoryMap[hint] ?? '')}`).join('、')}
                  </span>
                </summary>
                <div className="grid gap-3 border-t p-3 sm:grid-cols-2">
                  {s.hints.map((hint) => (
                    <FieldSelect
                      key={hint}
                      label={`巧明日常「${CATEGORY_HINT_NAME[hint]}」`}
                      value={s.categoryMap[hint] ?? ''}
                      placeholder="選擇 RMoney 類別"
                      options={categoryOptions}
                      onChange={(value) => s.setCategory(hint, value)}
                      invalid={!s.categoryMap[hint]}
                    />
                  ))}
                </div>
              </details>
            </section>

            {/* 3. 預覽並匯入 */}
            <section className="space-y-3">
              <StepTitle index={3} title="預覽並匯入" done={allDone && s.summary.imported > 0} />
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">已勾選 {s.summary.count} / {s.summary.selectable} 筆</span>
                <Button variant="ghost" size="sm" disabled={s.busy} onClick={() => s.selectAll(true)}>全選</Button>
                <Button variant="ghost" size="sm" disabled={s.busy} onClick={() => s.selectAll(false)}>全不選</Button>
                {s.summary.similar > 0 ? (
                  <Button variant="ghost" size="sm" disabled={s.busy} onClick={() => s.selectAll(true, true)}>連同 {s.summary.similar} 筆疑似重複一起勾</Button>
                ) : null}
              </div>
              <ul className="divide-y rounded-lg border">
                {s.rows.map((row) => (
                  <PreviewRowItem
                    key={row.item.sourceId}
                    row={row}
                    busy={s.busy}
                    onToggle={(include) => s.toggleRow(row.item.sourceId, include)}
                    categoryName={categoryName(s.categoryMap[row.item.categoryHint] ?? '')}
                    groupName={s.tripGroups.length > 1 ? row.item.target.nameHint : undefined}
                  />
                ))}
              </ul>

              <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+68px)] z-10 space-y-2 rounded-lg border bg-background/95 p-3 pr-20 shadow-sm backdrop-blur lg:bottom-2 lg:pr-3">
                {s.busy ? <Progress value={s.progress.total ? (s.progress.done / s.progress.total) * 100 : 0} /> : null}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs text-muted-foreground">
                    <div className="flex items-center gap-1.5 text-sm text-foreground"><Wallet className="size-4" />帳戶扣款 <span className="font-semibold tabular-nums">{twd(s.summary.chargedTWD)}</span></div>
                    記進你的花費 {twd(s.summary.myShareTWD)}
                    {s.summary.skipped ? ` · ${s.summary.skipped} 筆略過` : ''}
                    {s.summary.blocked ? ` · ${s.summary.blocked} 筆待補` : ''}
                  </div>
                  <Button onClick={() => void s.runImport()} disabled={s.busy || s.summary.count === 0}>
                    {s.busy ? <><Loader2 className="size-4 animate-spin" />匯入中 {s.progress.done}/{s.progress.total}</> : <>匯入 {s.summary.count} 筆<ArrowRight className="size-4" /></>}
                  </Button>
                </div>
              </div>
            </section>
          </>
        ) : null}

        {/* 4. 回執 */}
        {s.receiptCount > 0 ? (
          <section className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-primary" />
              <div className="text-sm">
                <p className="font-medium">已入帳 {s.receiptCount} 筆</p>
                <p className="text-muted-foreground">複製回執，到巧明日常「費用 → 貼上回執」，那邊才會標成已匯入。</p>
              </div>
            </div>
            <Button className="w-full sm:w-auto" onClick={() => void s.copyReceipt()}><Copy className="size-4" />複製回執</Button>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">顯示回執內容</summary>
              <textarea className="mt-2 min-h-20 w-full rounded-md border bg-background p-2 font-mono" aria-label="RMoney 匯入回執" readOnly value={s.receipt} onFocus={(event) => event.currentTarget.select()} />
            </details>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
