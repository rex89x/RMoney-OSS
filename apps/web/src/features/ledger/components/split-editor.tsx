import { PiggyBank } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn, formatCurrency } from '@/lib/utils';
import type { Currency } from '@/types/global';
import { HOUSEHOLD_FUND_PAYER_ID, type TxShare } from '../types';

/**
 * 分攤的單一來源：旅程成員、共同帳本成員、或兩者聯集都用同一個編輯器與同一組算法。
 * 金額一律以「交易原幣」輸入與計算，TWD 由 `amount × fxRate` 換算；存進 tx 的 `customShares`
 * 兩個都帶（`amount` 原幣、`amountTWD` 結算用）。
 */
export type SplitMode = 'ratio' | 'equal' | 'payer' | 'others' | 'custom';

export const SPLIT_MODE_LABEL: Record<SplitMode, string> = {
  ratio: '依預設比例',
  equal: '均分',
  payer: '全由付款人負擔',
  others: '付款人代墊（其他人負擔）',
  custom: '自訂金額',
};

/**
 * 共同帳本的記帳方式（UI 預設組合，底層仍是 payerId + mode）：
 * - fund：帳本負擔，由公基金支付（預設；不形成誰欠誰）
 * - half：一人先付、兩人各付一半（equal）
 * - advance：一人先付、另一人全額負擔（others）
 * - advanced：其他分法（完整編輯器）
 */
export type HouseholdSplitPreset = 'fund' | 'half' | 'advance' | 'advanced';

export function presetOfSplit(state: SplitState): HouseholdSplitPreset {
  if (state.payerId === HOUSEHOLD_FUND_PAYER_ID) return 'fund';
  if (state.mode === 'equal') return 'half';
  if (state.mode === 'others') return 'advance';
  return 'advanced';
}

export interface SplitMember {
  /** uid（有帳號）或名字（純旅伴） */
  id: string;
  name: string;
  /** 是共同帳本成員（UI 標示；trip + household 併用時成員間的錢在共同帳本結） */
  household?: boolean;
}

export interface SplitState {
  payerId: string;
  mode: SplitMode;
  /** 自訂金額（原幣）的輸入字串，key = member id */
  custom: Record<string, string>;
  /** 帳本負擔（公基金）時由誰先墊付；空字串 / 沒有 = 公基金直接付 */
  fundAdvancedBy?: string;
}

export interface SplitShare {
  /** 原幣 */
  amount: number;
  /** 台幣（整數） */
  amountTWD: number;
}

export interface SplitInput {
  members: SplitMember[];
  /** 原幣總額 */
  amount: number;
  currency: Currency;
  fxRate: number;
  state: SplitState;
  /** 'ratio' 模式用的比例（%），key = member id；沒給或總和為 0 時退回均分 */
  ratio?: Record<string, number>;
}

/** 沒有小數的幣別：金額四捨五入到整數 */
const ZERO_DECIMAL_CURRENCIES = new Set(['TWD', 'JPY', 'KRW', 'IDR', 'VND']);

export function currencyDecimals(currency: Currency): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
}

function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** 依權重把總額拆開；尾差補給最後一個有權重的人，保證加總等於總額 */
function distribute(total: number, ids: string[], weights: Record<string, number>, decimals: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = 0;
  const active = ids.filter((id) => (weights[id] ?? 0) > 0);
  const sumW = active.reduce((s, id) => s + (weights[id] ?? 0), 0);
  if (active.length === 0 || sumW <= 0) return out;
  let allocated = 0;
  active.forEach((id, i) => {
    const share = i === active.length - 1
      ? roundTo(total - allocated, decimals)
      : roundTo((total * (weights[id] ?? 0)) / sumW, decimals);
    out[id] = share;
    allocated = roundTo(allocated + share, decimals);
  });
  return out;
}

export function parseSplitCustom(custom: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(custom)) out[k] = Math.max(0, parseFloat(v) || 0);
  return out;
}

/** 各成員應負擔（原幣 + 台幣）。公基金付款 → 全部 0（不形成誰欠誰）。 */
export function computeSplit(input: SplitInput): Record<string, SplitShare> {
  const { members, amount, currency, fxRate, state, ratio } = input;
  const ids = members.map((m) => m.id);
  const decimals = currencyDecimals(currency);
  const total = roundTo(Math.max(0, amount), decimals);
  const toTWD = (v: number) => Math.round(currency === 'TWD' ? v : v * fxRate);
  const wrap = (raw: Record<string, number>): Record<string, SplitShare> =>
    Object.fromEntries(ids.map((id) => [id, { amount: raw[id] ?? 0, amountTWD: toTWD(raw[id] ?? 0) }]));

  if (state.payerId === HOUSEHOLD_FUND_PAYER_ID) return wrap({});
  switch (state.mode) {
    case 'payer':
      return wrap(Object.fromEntries(ids.map((id) => [id, id === state.payerId ? total : 0])));
    case 'others': {
      // 付款人只是代墊：其他成員平分；只有付款人一個人時退回付款人自己負擔
      const others = ids.filter((id) => id !== state.payerId);
      if (others.length === 0) return wrap(Object.fromEntries(ids.map((id) => [id, total])));
      return wrap(distribute(total, ids, Object.fromEntries(others.map((id) => [id, 1])), decimals));
    }
    case 'custom': {
      const parsed = parseSplitCustom(state.custom);
      return wrap(Object.fromEntries(ids.map((id) => [id, roundTo(parsed[id] ?? 0, decimals)])));
    }
    case 'ratio': {
      const weights = ratio ?? {};
      const hasRatio = ids.some((id) => (weights[id] ?? 0) > 0);
      if (hasRatio) return wrap(distribute(total, ids, weights, decimals));
      return wrap(distribute(total, ids, Object.fromEntries(ids.map((id) => [id, 1])), decimals));
    }
    case 'equal':
    default:
      return wrap(distribute(total, ids, Object.fromEntries(ids.map((id) => [id, 1])), decimals));
  }
}

/** 自訂金額加總 ≠ 總額（原幣比較；公基金付款不檢查） */
export function splitMismatch(input: SplitInput, shares = computeSplit(input)): boolean {
  if (input.state.mode !== 'custom' || input.state.payerId === HOUSEHOLD_FUND_PAYER_ID || input.amount <= 0) return false;
  const decimals = currencyDecimals(input.currency);
  const sum = Object.values(shares).reduce((s, v) => s + v.amount, 0);
  const tolerance = decimals === 0 ? 0.5 : 0.005;
  return Math.abs(sum - input.amount) > tolerance;
}

/** 轉成 tx.customShares；非台幣交易同時帶原幣 `amount` */
export function toTxShares(shares: Record<string, SplitShare>, currency: Currency, memberIds: string[]): TxShare[] {
  return memberIds.map((id) => {
    const s = shares[id] ?? { amount: 0, amountTWD: 0 };
    return currency === 'TWD'
      ? { memberId: id, amountTWD: s.amountTWD }
      : { memberId: id, amountTWD: s.amountTWD, amount: s.amount };
  });
}

/** 把既有 tx.customShares 還原成自訂金額輸入（原幣優先；舊資料只有 TWD 就換算回去） */
export function customFromTxShares(
  shares: TxShare[] | undefined,
  currency: Currency,
  fxRate: number,
  memberIds: string[],
): Record<string, string> {
  const decimals = currencyDecimals(currency);
  const out: Record<string, string> = {};
  for (const id of memberIds) out[id] = '';
  for (const c of shares ?? []) {
    const amount = typeof c.amount === 'number'
      ? c.amount
      : currency === 'TWD' || fxRate <= 0 ? c.amountTWD : c.amountTWD / fxRate;
    out[c.memberId] = String(roundTo(amount, decimals));
  }
  return out;
}

interface SplitEditorProps extends SplitInput {
  onChange: (next: SplitState) => void;
  /** 顯示「公基金」付款選項（只有純共同支出才有） */
  allowFund?: boolean;
  availableFundTWD?: number | null;
  /** 顯示「依預設比例」（只有成員全是共同帳本成員時才有意義） */
  showRatio?: boolean;
  /** 目前登入者（標「（我）」） */
  viewerId?: string;
  /** 交易建立者：付款人 = 建立者才會扣建立者的帳戶 */
  creatorId?: string;
}

export function SplitEditor({
  members, amount, currency, fxRate, state, ratio, onChange,
  allowFund = false, availableFundTWD = null, showRatio = false, viewerId, creatorId,
}: SplitEditorProps) {
  const input: SplitInput = { members, amount, currency, fxRate, state, ratio };
  const shares = computeSplit(input);
  const mismatch = splitMismatch(input, shares);
  const fundPaid = state.payerId === HOUSEHOLD_FUND_PAYER_ID;
  const amountTWD = Math.round(currency === 'TWD' ? amount : amount * fxRate);
  const insufficientFund = fundPaid && availableFundTWD != null && amountTWD > availableFundTWD;
  const sumAmount = Object.values(shares).reduce((s, v) => s + v.amount, 0);
  // 共同帳本用上方的記帳方式選；進階清單不重複列「代墊」
  const modes = (Object.keys(SPLIT_MODE_LABEL) as SplitMode[])
    .filter((m) => (m !== 'ratio' || showRatio) && (m !== 'others' || !allowFund));
  const payerName = members.find((m) => m.id === state.payerId)?.name ?? '對方';
  const fmt = (v: number) => (currency === 'TWD' ? formatCurrency(v, 'TWD') : `${currency} ${v.toLocaleString()}`);
  const preset = allowFund ? presetOfSplit(state) : 'advanced';
  /** 從公基金切到其他方式時，付款人預設用建立者 / 我 */
  const firstPayer = (creatorId && members.some((m) => m.id === creatorId) ? creatorId : undefined)
    ?? (viewerId && members.some((m) => m.id === viewerId) ? viewerId : undefined)
    ?? members[0]?.id ?? '';
  const realPayer = fundPaid ? firstPayer : state.payerId;

  function choosePreset(next: HouseholdSplitPreset) {
    if (next === 'fund') onChange({ ...state, payerId: HOUSEHOLD_FUND_PAYER_ID });
    else if (next === 'half') onChange({ ...state, payerId: realPayer, mode: 'equal' });
    else if (next === 'advance') onChange({ ...state, payerId: realPayer, mode: 'others' });
    else onChange({ ...state, payerId: realPayer, mode: state.mode === 'equal' || state.mode === 'others' ? (showRatio ? 'ratio' : 'custom') : state.mode });
  }

  const payerPicker = (
    <div>
      <Label className="text-xs">{preset === 'advanced' ? '誰付的' : '誰先付'}</Label>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {members.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onChange({ ...state, payerId: m.id })}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-sm transition-colors',
              state.payerId === m.id ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
            )}
          >
            {m.name}{m.id === viewerId ? '（我）' : ''}
            {m.household && !allowFund ? <span className="text-[10px] text-muted-foreground">共同</span> : null}
          </button>
        ))}
      </div>
      {creatorId && state.payerId !== creatorId && !fundPaid ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          由 {payerName} 付款，不會扣{creatorId === viewerId ? '你' : '記錄者'}的帳戶。
        </p>
      ) : null}
    </div>
  );

  const sharesList = (
    <div className="space-y-1.5 rounded-lg bg-muted/40 p-2 text-xs">
      {members.map((m) => {
        const s = shares[m.id] ?? { amount: 0, amountTWD: 0 };
        return (
          <div key={m.id} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              {m.name}{m.id === viewerId ? '（我）' : ''}
              {m.household && !allowFund ? <span className="ml-1 text-[10px] text-muted-foreground">共同</span> : null}
              {preset !== 'advanced' ? <span className="ml-1 text-[10px] text-muted-foreground">負擔</span> : null}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {state.mode === 'custom' && preset === 'advanced' ? (
                <>
                  {currency !== 'TWD' ? <span className="text-[10px] text-muted-foreground">{currency}</span> : null}
                  <Input
                    type="number"
                    inputMode="decimal"
                    step={currencyDecimals(currency) === 0 ? '1' : '0.01'}
                    value={state.custom[m.id] ?? ''}
                    onChange={(e) => onChange({ ...state, custom: { ...state.custom, [m.id]: e.target.value } })}
                    className="h-8 w-28 text-right tabular-nums"
                    placeholder="0"
                    aria-label={`${m.name} 的分攤金額`}
                  />
                </>
              ) : (
                <span className="font-medium tabular-nums">{fmt(s.amount)}</span>
              )}
              {currency !== 'TWD' ? (
                <span className="w-20 text-right text-[10px] tabular-nums text-muted-foreground">≈ {formatCurrency(s.amountTWD, 'TWD')}</span>
              ) : null}
            </span>
          </div>
        );
      })}
      {mismatch ? (
        <p className="text-destructive">加總 {fmt(sumAmount)} ≠ 總額 {fmt(roundTo(amount, currencyDecimals(currency)))}</p>
      ) : null}
      {currency !== 'TWD' ? (
        <p className="text-[10px] text-muted-foreground">以 {currency} 輸入即可，台幣依這筆的匯率 {fxRate.toFixed(4)} 換算。</p>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-3">
      {allowFund ? (
        <div>
          <Label className="text-xs">記帳方式</Label>
          <div className="mt-1 grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="記帳方式">
            {PRESETS.map((item) => (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={preset === item.value}
                onClick={() => choosePreset(item.value)}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-lg border p-2 text-left transition-colors',
                  item.value === 'fund' && 'col-span-2',
                  preset === item.value ? 'border-primary bg-primary/10' : 'hover:bg-muted',
                )}
              >
                <span className={cn('flex items-center gap-1.5 text-sm font-medium', preset === item.value && 'text-primary')}>
                  {item.value === 'fund' ? <PiggyBank className="size-4" /> : null}
                  {item.label}
                </span>
                <span className="text-[11px] leading-snug text-muted-foreground">{item.hint}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {fundPaid && allowFund ? (
        <div>
          <Label className="text-xs">實際由誰付出去</Label>
          <div className="mt-1 flex flex-wrap gap-1.5" role="radiogroup" aria-label="實際由誰付出去">
            {[{ id: '', name: '公基金直接付' }, ...members.map((m) => ({ id: m.id, name: `${m.name}${m.id === viewerId ? '（我）' : ''}先墊` }))].map((option) => {
              const active = (state.fundAdvancedBy ?? '') === option.id;
              return (
                <button
                  key={option.id || '__fund__'}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onChange({ ...state, fundAdvancedBy: option.id })}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-sm transition-colors',
                    active ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
                  )}
                >
                  {option.name}
                </button>
              );
            })}
          </div>
          {state.fundAdvancedBy ? (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              仍由公基金負擔；公基金之後要撥還 {members.find((m) => m.id === state.fundAdvancedBy)?.name ?? '對方'} {formatCurrency(amountTWD, 'TWD')}，到「公基金 → 待撥還」記錄轉帳即可結清。
            </p>
          ) : null}
        </div>
      ) : null}

      {fundPaid ? (
        <p className={cn('rounded-lg border p-2 text-xs', insufficientFund ? 'border-warning/50 text-warning' : 'text-muted-foreground')}>
          {availableFundTWD != null ? `公基金可用 ${formatCurrency(availableFundTWD, 'TWD')}` : '由公基金支付'}
          {insufficientFund
            ? `，這筆之後餘額會變成 ${formatCurrency((availableFundTWD ?? 0) - amountTWD, 'TWD')}，記得補存公基金。`
            : '；直接從公基金扣除，不用算誰付、誰負擔。'}
        </p>
      ) : (
        <>
          {payerPicker}
          {preset === 'advanced' ? (
            <div>
              <Label className="text-xs">怎麼分</Label>
              <div className="mt-1 grid grid-cols-2 gap-1.5">
                {modes.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => onChange({ ...state, mode: m })}
                    className={cn(
                      'rounded-md border p-2 text-xs transition-colors',
                      state.mode === m ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
                    )}
                  >
                    {SPLIT_MODE_LABEL[m]}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {sharesList}
        </>
      )}
    </div>
  );
}

const PRESETS: Array<{ value: HouseholdSplitPreset; label: string; hint: string }> = [
  { value: 'fund', label: '帳本負擔（公基金）', hint: '預設：直接從公基金扣，不分誰付、誰負擔' },
  { value: 'half', label: '各付一半', hint: '一人先付，兩人平分' },
  { value: 'advance', label: '代墊：另一人全額負擔', hint: '一人先付，費用全算對方的' },
  { value: 'advanced', label: '其他分法', hint: '依比例、自訂金額…' },
];
