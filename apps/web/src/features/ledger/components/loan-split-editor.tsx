import { Label } from '@/components/ui/label';
import { cn, formatCurrency } from '@/lib/utils';
import type { Transaction } from '../types';

export type LoanSplitMode = NonNullable<Transaction['splitMode']>;

const MODE_LABEL: Record<LoanSplitMode, string> = {
  self: '只有我',
  'i-paid-others': '我先付',
  'they-paid-mine': '對方先付',
};

interface LoanSplitEditorProps {
  mode: LoanSplitMode;
  onModeChange: (mode: LoanSplitMode) => void;
  counterpartyName: string;
  onCounterpartyNameChange: (value: string) => void;
  /** 我這份（TWD）的輸入字串；空白 = 全部都是我承擔 */
  myShare: string;
  onMyShareChange: (value: string) => void;
  /** 總額 TWD（算「對方要還我 / 我要還他」用） */
  totalTWD: number;
  /** 有給才顯示「已結清」勾選（編輯既有交易時） */
  settled?: boolean;
  onSettledChange?: (value: boolean) => void;
}

/** 代墊金額：總額 − 我這份 */
export function loanOwedTWD(totalTWD: number, myShare: string): number {
  const mine = parseFloat(myShare) || 0;
  return Math.max(0, totalTWD - mine);
}

/**
 * 一般記帳的代墊 / 借貸（不限 trip）。
 * 受控元件；快速記帳與編輯交易共用，結果寫進 tx 的 `splitMode` / `counterpartyName` / `myShareTWD`。
 */
export function LoanSplitEditor({
  mode, onModeChange, counterpartyName, onCounterpartyNameChange,
  myShare, onMyShareChange, totalTWD, settled, onSettledChange,
}: LoanSplitEditorProps) {
  const owed = loanOwedTWD(totalTWD, myShare);
  const who = counterpartyName || '對方';
  return (
    <details className="rounded-xl border p-3" open={mode !== 'self'}>
      <summary className="cursor-pointer text-sm font-medium">
        代墊 / 借貸
        {mode !== 'self' ? (
          <span className="ml-2 text-xs text-muted-foreground">
            ({MODE_LABEL[mode]} · {counterpartyName || '未填'}{settled ? ' · 已結清' : ''})
          </span>
        ) : null}
      </summary>
      <div className="mt-3 space-y-3">
        <div className="grid grid-cols-3 gap-1.5">
          {(Object.keys(MODE_LABEL) as LoanSplitMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              className={cn(
                'rounded-md border p-2 text-xs transition-colors',
                mode === m ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
              )}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        {mode !== 'self' ? (
          <div className="grid gap-2 md:grid-cols-2">
            <div>
              <Label className="text-xs">對方姓名</Label>
              <input
                value={counterpartyName}
                onChange={(e) => onCounterpartyNameChange(e.target.value)}
                placeholder="小明"
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs">我這份 (TWD)</Label>
              <input
                type="number"
                inputMode="decimal"
                value={myShare}
                onChange={(e) => onMyShareChange(e.target.value)}
                placeholder={totalTWD > 0 ? `總額一半 ${Math.round(totalTWD / 2)}` : '空白 = 全部都是我承擔'}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm tabular-nums"
              />
            </div>
            <p className="text-[11px] text-muted-foreground md:col-span-2">
              {mode === 'i-paid-others'
                ? `我代墊全額；${who} 之後要還我 ${formatCurrency(owed, 'TWD')}`
                : `${who} 先付了；我要還他 ${formatCurrency(owed, 'TWD')}`}
            </p>
            {onSettledChange ? (
              <label className="flex cursor-pointer items-center gap-2 text-xs md:col-span-2">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={settled === true}
                  onChange={(e) => onSettledChange(e.target.checked)}
                />
                已結清（{mode === 'i-paid-others' ? '對方已還我' : '我已還對方'}）
              </label>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}
