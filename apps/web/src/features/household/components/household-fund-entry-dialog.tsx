import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Loader2, PiggyBank, Save, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { formatTW } from '@/lib/tz';
import { cn, formatCurrency } from '@/lib/utils';
import { useCategories } from '@/features/ledger/hooks';
import { effectiveAmountTWD } from '@/features/ledger/types';
import {
  useConvertFundEntryToReimbursement, useCreateHouseholdFundEntry, useHouseholdFundSummary, useUpdateHouseholdFundEntry,
} from '../hooks';
import { findExactExpenseMatch, reimbursementCandidateTxs } from '../balance';
import { fundPlanMonthKey } from '../fund-plan';
import { memberCan, type Household, type HouseholdFundEntry } from '../types';

/** 「記錄本月固定存入」時帶入的預設值 */
export interface FundEntryPreset {
  amountTWD: number;
  planMonth: string;
  note: string;
  date: Date;
}

interface HouseholdFundEntryDialogProps {
  household: Household;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 有值 = 修改這筆存入 */
  entry?: HouseholdFundEntry | null;
  preset?: FundEntryPreset | null;
}

export function HouseholdFundEntryDialog({
  household,
  open,
  onOpenChange,
  entry = null,
  preset = null,
}: HouseholdFundEntryDialogProps) {
  const { user } = useAuth();
  const createEntry = useCreateHouseholdFundEntry();
  const updateEntry = useUpdateHouseholdFundEntry();
  const convertEntry = useConvertFundEntryToReimbursement();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date());
  const [note, setNote] = useState('');
  /** 計入「每月固定存入」：本月的計畫進度會把這筆算進去 */
  const [countAsPlan, setCountAsPlan] = useState(false);
  /**
   * 「這筆其實是公基金補錢給先墊的人」：記錯成存入的撥還，改成撥還（公基金 → 原存入者）。
   * 只有修改既有的存入、而且有「公基金管理」權限、又能刪這筆的人才看得到。
   */
  const [asReimbursement, setAsReimbursement] = useState(false);
  const [advancedTxIds, setAdvancedTxIds] = useState<string[]>([]);
  const pending = createEntry.isPending || updateEntry.isPending || convertEntry.isPending;
  const myUid = user?.uid ?? '';
  const canConvert = Boolean(entry && entry.type === 'contribution' && entry.contributorUid
    && memberCan(household, myUid, 'canManageFund')
    && (entry.createdBy === myUid || household.ownerId === myUid));
  // FAB 常駐掛著這個對話框：只有「修改存入、可改成撥還」時才訂閱共同支出，避免每頁都多開 listener
  const { fundExpenses } = useHouseholdFundSummary(open && canConvert ? household : null);
  const { data: categories = [] } = useCategories();
  const planEnabled = Boolean(household.fundPlan?.enabled);

  useEffect(() => {
    if (!open) return;
    if (entry) {
      setAmount(String(entry.amountTWD));
      setDate(entry.date);
      setNote(entry.note ?? '');
      setCountAsPlan(Boolean(entry.planMonth));
      setAsReimbursement(false);
      setAdvancedTxIds([]);
      return;
    }
    setAsReimbursement(false);
    setAdvancedTxIds([]);
    setAmount(preset ? String(preset.amountTWD) : '');
    setDate(preset?.date ?? new Date());
    setNote(preset?.note ?? '');
    setCountAsPlan(Boolean(preset));
  }, [open, entry, preset]);

  const contributorName = household.members[entry?.contributorUid ?? user?.uid ?? '']?.displayName ?? '我';
  const catMap = useMemo(() => Object.fromEntries(categories.map((c) => [c.key, c.name])), [categories]);
  const candidates = useMemo(
    () => (canConvert ? reimbursementCandidateTxs(fundExpenses, date) : []),
    [canConvert, fundExpenses, date],
  );
  const selectedSum = useMemo(
    () => candidates.filter((tx) => advancedTxIds.includes(tx.id)).reduce((sum, tx) => sum + effectiveAmountTWD(tx), 0),
    [candidates, advancedTxIds],
  );

  function toggleReimbursement(next: boolean) {
    setAsReimbursement(next);
    // 打開時預先勾「金額剛好加總相等」的支出；找不到就讓使用者自己勾
    setAdvancedTxIds(next ? findExactExpenseMatch(candidates, Number(amount) || 0) : []);
  }

  async function handleSave() {
    const amountTWD = Math.round(Number(amount));
    if (!user || amountTWD <= 0) return;
    try {
      if (entry && asReimbursement && entry.contributorUid) {
        await convertEntry.mutateAsync({
          householdId: household.id,
          entry,
          myUid: user.uid,
          toUid: entry.contributorUid,
          amountTWD,
          date,
          note: note.trim() || null,
          advancedTxIds,
        });
        toast.success(`已改成公基金撥還給${contributorName}`);
      } else if (entry) {
        await updateEntry.mutateAsync({
          householdId: household.id,
          id: entry.id,
          patch: { amountTWD, date, note: note.trim() || null },
        });
        toast.success('已更新公基金存入');
      } else {
        await createEntry.mutateAsync({
          householdId: household.id,
          input: {
            type: 'contribution',
            amountTWD,
            contributorUid: user.uid,
            note: note.trim() || null,
            date,
            createdBy: user.uid,
            planMonth: countAsPlan ? (preset?.planMonth ?? fundPlanMonthKey(date)) : null,
            source: 'manual',
          },
        });
        toast.success('已存入公基金');
      }
      onOpenChange(false);
    } catch (error) {
      console.error('[saveHouseholdFundEntry]', error);
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => { if (!pending) onOpenChange(next); }}
      title={entry ? (entry.type === 'reimbursement' ? '修改公基金撥還' : '修改公基金存入') : preset ? '記錄本月固定存入' : '存入公基金'}
      description={entry?.type === 'reimbursement' ? `${household.name} · 撥還給${contributorName}` : `${household.name} · ${contributorName}存入`}
      contentClassName="sm:max-w-md"
      footer={(
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="flex-1 h-12" onClick={() => onOpenChange(false)} disabled={pending}>取消</Button>
          <Button type="button" className="flex-[2] h-12" onClick={() => void handleSave()} disabled={Number(amount) <= 0 || pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : entry ? <Save className="size-4" /> : <PiggyBank className="size-4" />}
            {entry ? (asReimbursement ? '改成撥還' : '儲存修改') : '確認存入'}
          </Button>
        </div>
      )}
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="fund-amount">金額（TWD）</Label>
          <Input
            id="fund-amount"
            type="number"
            inputMode="decimal"
            min="1"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0"
            className="mt-1 h-12 text-2xl font-semibold tabular-nums"
            autoFocus
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>日期</Label>
            <div className="mt-1"><DatePicker value={date} onChange={(value) => { if (value) setDate(value); }} /></div>
          </div>
          <div>
            <Label htmlFor="fund-note">備註</Label>
            <Textarea id="fund-note" value={note} onChange={(event) => setNote(event.target.value)} rows={1} className="mt-1 min-h-10" placeholder="例：九月公基金" />
          </div>
        </div>
        {!entry && planEnabled ? (
          <label className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
            <span>
              <span className="font-medium">算進每月固定存入</span>
              <span className="block text-xs text-muted-foreground">
                計入 {preset?.planMonth ?? fundPlanMonthKey(date)} 的計畫進度；關掉就當成臨時加碼
              </span>
            </span>
            <Switch checked={countAsPlan} onCheckedChange={setCountAsPlan} aria-label="算進每月固定存入" />
          </label>
        ) : null}
        {canConvert ? (
          <div className="space-y-3 rounded-xl border p-3">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                <span className="flex items-center gap-1.5 font-medium"><Undo2 className="size-4" /> 這筆其實是公基金補錢給{contributorName}</span>
                <span className="block text-xs text-muted-foreground">
                  {contributorName}先墊了公基金的支出、之後由公基金把錢轉給他，應該記成「撥還」（公基金 − ），不是存入（＋）。
                </span>
              </span>
              <Switch checked={asReimbursement} onCheckedChange={toggleReimbursement} aria-label="改成公基金撥還" />
            </label>
            {asReimbursement ? (
              <div className="space-y-2">
                <div className="flex items-center justify-center gap-2 rounded-lg bg-muted/50 p-2 text-xs">
                  <PiggyBank className="size-3.5" /> 公基金 <ArrowRight className="size-3.5" /> {contributorName}
                  <span className="font-semibold tabular-nums">{formatCurrency(Number(amount) || 0, 'TWD')}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  勾選這次補的是哪幾筆支出，會標成「{contributorName}先墊」，待撥還才會剛好結清：
                </p>
                {candidates.length === 0 ? (
                  <p className="rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground">
                    近 90 天沒有「公基金負擔、還沒標先墊」的支出。若那筆支出記成「{contributorName}付」，請先到交易把記帳方式改成「帳本負擔」並選「{contributorName}先墊」。
                  </p>
                ) : (
                  <ul className="max-h-56 divide-y overflow-y-auto rounded-lg border">
                    {candidates.map((tx) => {
                      const checked = advancedTxIds.includes(tx.id);
                      return (
                        <li key={tx.id}>
                          <label className={cn('flex cursor-pointer items-center gap-2 p-2 text-xs', checked && 'bg-primary/5')}>
                            <input
                              type="checkbox"
                              className="size-4 accent-primary"
                              checked={checked}
                              onChange={(event) => setAdvancedTxIds((prev) => (
                                event.target.checked ? [...prev, tx.id] : prev.filter((id) => id !== tx.id)
                              ))}
                            />
                            <span className="tabular-nums text-muted-foreground">{formatTW(tx.date, 'M/d')}</span>
                            <span className="min-w-0 flex-1 truncate">
                              {catMap[tx.category] ?? tx.category}{tx.note ? ` · ${tx.note}` : ''}
                            </span>
                            <span className="font-medium tabular-nums">{formatCurrency(effectiveAmountTWD(tx), 'TWD')}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className={cn(
                  'text-xs tabular-nums',
                  Math.round(selectedSum) === Math.round(Number(amount) || 0) ? 'text-success' : 'text-muted-foreground',
                )}>
                  已勾 {formatCurrency(selectedSum, 'TWD')} / 撥還 {formatCurrency(Number(amount) || 0, 'TWD')}
                  {reimburseGapText(selectedSum, Number(amount) || 0, contributorName)}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
        {entry?.planMonth && !asReimbursement ? (
          <p className="text-xs text-muted-foreground">這筆屬於 {entry.planMonth} 的每月固定存入{entry.source === 'plan' ? '（系統自動記錄）' : ''}。</p>
        ) : null}
        <p className={entry?.type === 'reimbursement' || asReimbursement ? 'hidden' : 'text-xs text-muted-foreground'}>
          此處只增加共同公基金餘額，不會自動新增或扣除個人帳本；共同支出選擇「公基金」付款後才會扣除。
        </p>
      </div>
    </ResponsiveDialog>
  );
}

function reimburseGapText(selectedTWD: number, amountTWD: number, name: string): string {
  const gap = Math.round(selectedTWD) - Math.round(amountTWD);
  if (gap === 0) return '（剛好結清）';
  if (gap > 0) return `（公基金還欠${name} ${formatCurrency(gap, 'TWD')}，會留在「待撥還」）`;
  return `（多撥的 ${formatCurrency(-gap, 'TWD')} 會記成${name}欠公基金）`;
}
