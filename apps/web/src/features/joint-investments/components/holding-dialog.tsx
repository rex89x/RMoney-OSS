import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { memberCan, type Household } from '@/features/household/types';
import { memberColor, HOUSEHOLD_FUND_COLOR } from '@/features/household/entries';
import { normalizeJointSymbol } from '../calc';
import { useCreateJointHolding } from '../hooks';
import { JointHoldingFormSchema } from '../schema';

interface HoldingDialogProps {
  household: Household;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 新增持股：選誰持有（共同 / 我自己）→ 代號 → 第一筆買進 */
export function HoldingDialog({ household, open, onOpenChange }: HoldingDialogProps) {
  const { user } = useAuth();
  const myUid = user?.uid ?? '';
  const create = useCreateJointHolding();
  const canJoint = memberCan(household, myUid, 'canManageInvestments');

  const [bucketKey, setBucketKey] = useState('joint');
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [date, setDate] = useState(() => new Date());
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [fee, setFee] = useState('');
  const [note, setNote] = useState('');
  const [ratio, setRatio] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setBucketKey(canJoint ? 'joint' : myUid);
    setSymbol(''); setName(''); setDate(new Date()); setShares(''); setPrice(''); setFee(''); setNote('');
    setErrors({});
    const r: Record<string, string> = {};
    for (const id of household.memberIds) r[id] = String(household.splitRatio[id] ?? 0);
    setRatio(r);
  }, [open, canJoint, myUid, household.memberIds, household.splitRatio]);

  const normalized = useMemo(() => normalizeJointSymbol(symbol), [symbol]);
  const ratioSum = household.memberIds.reduce((s, id) => s + (parseFloat(ratio[id] ?? '') || 0), 0);
  const ratioOk = Math.abs(ratioSum - 100) < 0.01;
  const totalNative = (parseFloat(shares) || 0) * (parseFloat(price) || 0) + (parseFloat(fee) || 0);

  const bucketOptions = [
    ...(canJoint ? [{ key: 'joint', label: '共同持有', hint: '依比例歸屬兩人', color: HOUSEHOLD_FUND_COLOR }] : []),
    { key: myUid, label: '我自己的', hint: '只算在我身上', color: memberColor(household, myUid) },
  ];

  async function handleSave() {
    if (!user) return;
    const parsed = JointHoldingFormSchema.safeParse({
      symbol, name, bucketKey, date,
      shares: shares === '' ? undefined : Number(shares),
      price: price === '' ? undefined : Number(price),
      fee: fee === '' ? 0 : Number(fee),
      note,
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
      setErrors(next);
      return;
    }
    if (bucketKey === 'joint' && !ratioOk) {
      setErrors({ ratio: '持有比例加總需為 100%' });
      return;
    }
    const sym = normalizeJointSymbol(parsed.data.symbol);
    if (!sym.ok) return;
    const jointShares: Record<string, number> = {};
    for (const id of household.memberIds) jointShares[id] = parseFloat(ratio[id] ?? '') || 0;
    const sameAsDefault = household.memberIds.every((id) => (household.splitRatio[id] ?? 0) === jointShares[id]);
    try {
      await create.mutateAsync({
        householdId: household.id,
        input: {
          symbol: sym.symbol,
          name: parsed.data.name || sym.symbol,
          market: sym.market,
          currency: sym.currency,
          bucket: bucketKey === 'joint' ? 'joint' : 'personal',
          ownerUid: bucketKey === 'joint' ? null : myUid,
          // 跟預設分攤一樣就存 null → 之後改 household 比例會一起跟著變
          jointShares: bucketKey === 'joint' && !sameAsDefault ? jointShares : null,
          lots: [{ side: 'buy', date: parsed.data.date, shares: parsed.data.shares, price: parsed.data.price, fee: parsed.data.fee }],
          source: 'manual',
          sourcePositionId: null,
          note: parsed.data.note || null,
          createdBy: myUid,
        },
      });
      toast.success(`已新增 ${sym.symbol}`);
      onOpenChange(false);
    } catch (err) {
      console.error('[saveJointHolding]', err);
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => { if (!create.isPending) onOpenChange(next); }}
      title="新增持股"
      description="記錄一檔股票的第一筆買進；之後可以在持股列表加碼或賣出"
      contentClassName="sm:max-w-lg"
      footer={(
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="h-12 flex-1" onClick={() => onOpenChange(false)} disabled={create.isPending}>取消</Button>
          <Button type="button" className="h-12 flex-[2]" onClick={() => void handleSave()} disabled={create.isPending}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} 新增
          </Button>
        </div>
      )}
    >
      <div className="space-y-4">
        <div>
          <Label>誰持有</Label>
          <div className="mt-1 grid grid-cols-2 gap-2" role="radiogroup" aria-label="誰持有">
            {bucketOptions.map((opt) => (
              <button
                key={opt.key}
                type="button"
                role="radio"
                aria-checked={bucketKey === opt.key}
                onClick={() => setBucketKey(opt.key)}
                className={cn(
                  'rounded-lg border p-3 text-left text-sm transition-colors',
                  bucketKey === opt.key ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                )}
              >
                <span className="flex items-center gap-1.5 font-medium">
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: opt.color }} aria-hidden />
                  {opt.label}
                </span>
                <span className="text-xs text-muted-foreground">{opt.hint}</span>
              </button>
            ))}
          </div>
          {!canJoint ? <p className="mt-1 text-xs text-muted-foreground">建立者沒有開放你記錄共同持有，只能記自己的。</p> : null}
        </div>

        {bucketKey === 'joint' ? (
          <div className="rounded-lg border bg-muted/30 p-3">
            <Label className="text-xs">持有比例（%）</Label>
            <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {household.memberIds.map((id) => (
                <label key={id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{household.members[id]?.displayName ?? id}{id === myUid ? '（我）' : ''}</span>
                  <Input
                    type="number"
                    inputMode="decimal"
                    className="h-9 w-20 text-right tabular-nums"
                    value={ratio[id] ?? ''}
                    onChange={(e) => setRatio({ ...ratio, [id]: e.target.value })}
                  />
                </label>
              ))}
            </div>
            <p className={cn('mt-1 text-xs', ratioOk ? 'text-muted-foreground' : 'text-destructive')}>
              加總 {Math.round(ratioSum)}%{ratioOk ? '，預設跟共同帳本的分攤比例一樣' : '（需為 100%）'}
            </p>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="jh-symbol">股票代號</Label>
            <Input
              id="jh-symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="0050、00878、VOO"
              className="mt-1 uppercase"
              autoCapitalize="characters"
              autoFocus
            />
            {errors.symbol ? <p className="mt-1 text-xs text-destructive">{errors.symbol}</p> : normalized.ok ? (
              <p className="mt-1 text-xs text-muted-foreground">{normalized.market === 'TW' ? '台股 · TWD' : '美股 · USD'}</p>
            ) : null}
          </div>
          <div>
            <Label htmlFor="jh-name">名稱（選填）</Label>
            <Input id="jh-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="元大台灣50" className="mt-1" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 sm:col-span-1">
            <Label>買進日期</Label>
            <div className="mt-1"><DatePicker value={date} onChange={(v) => { if (v) setDate(v); }} /></div>
          </div>
          <div>
            <Label htmlFor="jh-shares">股數</Label>
            <Input id="jh-shares" type="number" inputMode="decimal" value={shares} onChange={(e) => setShares(e.target.value)} placeholder="1000" className="mt-1 tabular-nums" />
            {errors.shares ? <p className="mt-1 text-xs text-destructive">{errors.shares}</p> : null}
          </div>
          <div>
            <Label htmlFor="jh-price">成交價（{normalized.ok ? normalized.currency : '原幣'}）</Label>
            <Input id="jh-price" type="number" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="mt-1 tabular-nums" />
            {errors.price ? <p className="mt-1 text-xs text-destructive">{errors.price}</p> : null}
          </div>
          <div>
            <Label htmlFor="jh-fee">手續費 + 稅</Label>
            <Input id="jh-fee" type="number" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0" className="mt-1 tabular-nums" />
            {errors.fee ? <p className="mt-1 text-xs text-destructive">{errors.fee}</p> : null}
          </div>
        </div>

        <div>
          <Label htmlFor="jh-note">備註（選填）</Label>
          <Input id="jh-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例：每月定期定額" className="mt-1" />
        </div>

        {errors.ratio ? <p className="text-xs text-destructive">{errors.ratio}</p> : null}
        {totalNative > 0 ? (
          <p className="rounded-md bg-muted/50 px-3 py-2 text-sm tabular-nums">
            投入金額 {totalNative.toLocaleString('en-US', { maximumFractionDigits: 2 })} {normalized.ok ? normalized.currency : ''}
          </p>
        ) : null}
      </div>
    </ResponsiveDialog>
  );
}
