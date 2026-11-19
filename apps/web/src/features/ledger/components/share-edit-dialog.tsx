import { useEffect, useMemo, useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { resolveIcon } from '@/lib/icons';
import { useHousehold } from '@/features/household/hooks';
import { useTrip } from '@/features/trips/hooks';
import { useCategories, useUpdateTransaction } from '../hooks';
import { buildSplitContext, canEditSplitOnly, canFullEditTx, initialSplitState, splitPatch } from '../split-context';
import { effectiveAmountTWD, type Transaction } from '../types';
import { SplitEditor, splitMismatch, type SplitState } from './split-editor';

interface ShareEditDialogProps {
  tx: Transaction | null;
  onClose: () => void;
}

/**
 * 夥伴用的「只改分攤」對話框：誰付、怎麼分、每個人多少（原幣輸入）。
 * 不含金額 / 類別 / 帳戶 — rules 只放行分攤欄位（txSplitEditableByPartner）。
 * 自己的交易或對方開放「可編輯」時請用 TransactionEditDialog。
 */
export function ShareEditDialog({ tx, onClose }: ShareEditDialogProps) {
  const { user, isViewer } = useAuth();
  const myUid = user?.uid ?? '';
  const { household: myHousehold } = useHousehold();
  const household = tx?.householdId && myHousehold?.id === tx.householdId ? myHousehold : null;
  const { data: trip } = useTrip(tx?.tripId ?? undefined);
  const { data: categories = [] } = useCategories();
  const update = useUpdateTransaction();

  const ctx = useMemo(() => (tx ? buildSplitContext({
    trip: tx.tripId ? trip ?? null : null,
    household,
    includeHousehold: Boolean(tx.householdId),
    fallback: { id: tx.userId, name: household?.members[tx.userId]?.displayName ?? '記錄者' },
  }) : null), [tx, trip, household]);

  const [state, setState] = useState<SplitState | null>(null);
  const memberKey = ctx?.members.map((m) => m.id).join(',') ?? '';
  useEffect(() => {
    if (!tx || !ctx) { setState(null); return; }
    setState(initialSplitState(tx, ctx.members, tx.currency, tx.fxRate));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 成員名單變了才重新帶入，不要每次 render 重置
  }, [tx?.id, memberKey]);

  if (!tx || !ctx || !state) return null;

  const allowed = canEditSplitOnly({ tx, myUid, isViewer, household, trip: trip ?? null }) || canFullEditTx(tx, myUid, household);
  const input = { members: ctx.members, amount: tx.amount, currency: tx.currency, fxRate: tx.fxRate, state, ratio: ctx.ratio };
  const mismatch = splitMismatch(input);
  const category = categories.find((c) => c.key === tx.category);
  const Icon = resolveIcon(category?.icon);
  const waitingTrip = Boolean(tx.tripId) && !trip;

  async function handleSave() {
    if (!tx || !allowed || mismatch) return;
    try {
      await update.mutateAsync({
        id: tx.id,
        patch: splitPatch({ creatorUid: tx.userId, input, isHousehold: Boolean(tx.householdId), isTrip: Boolean(tx.tripId) }),
      });
      onClose();
    } catch (err) {
      console.error('[shareEdit]', err);
      toast.error(err instanceof Error ? err.message : '更新失敗');
    }
  }

  return (
    <ResponsiveDialog
      open={Boolean(tx)}
      onOpenChange={(o) => { if (!o && !update.isPending) onClose(); }}
      title="修改分攤"
      description={[household?.name, trip?.name].filter(Boolean).join(' · ') || undefined}
      contentClassName="sm:max-w-md"
      footer={(
        <div className="flex gap-2">
          <Button variant="outline" className="h-12 flex-1" type="button" onClick={onClose} disabled={update.isPending}>取消</Button>
          <Button className="h-12 flex-[2]" type="button" onClick={() => void handleSave()} disabled={!allowed || mismatch || update.isPending || waitingTrip}>
            {update.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            儲存分攤
          </Button>
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-xl border p-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
            <Icon className="size-5" style={{ color: category?.color }} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{category?.name ?? tx.category}{tx.note ? <span className="ml-1 text-xs font-normal text-muted-foreground">· {tx.note}</span> : null}</div>
            <div className="text-xs text-muted-foreground">{formatTW(tx.date, 'yyyy/MM/dd (EEE)')}</div>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-semibold tabular-nums">{formatCurrency(effectiveAmountTWD(tx), 'TWD')}</div>
            {tx.currency !== 'TWD' ? <div className="text-[10px] tabular-nums text-muted-foreground">{tx.currency} {tx.amount.toLocaleString()}</div> : null}
          </div>
        </div>

        {!allowed ? (
          <p className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
            <Lock className="size-3.5" /> 你沒有修改這筆分攤的權限（要是共同帳本成員，或被分享這趟旅程）。
          </p>
        ) : null}

        <SplitEditor
          {...input}
          onChange={setState}
          allowFund={ctx.allowFund}
          showRatio={ctx.showRatio}
          viewerId={myUid}
          creatorId={tx.userId}
        />

        <p className="text-[11px] text-muted-foreground">
          只會改分攤明細；金額、類別、付款方式維持記錄者原本的設定。記錄者的帳本會同步顯示他那一份。
        </p>
      </div>
    </ResponsiveDialog>
  );
}
