import { useEffect, useMemo, useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/utils';
import { usePortfolio, useStocks } from '@/features/investments/hooks';
import { useSyncLinkedPositions } from '../hooks';
import type { JointHolding } from '../types';

interface LinkPortfolioDialogProps {
  householdId: string;
  holdings: readonly JointHolding[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * owner 把自己投資組合的部位「連結」到共同投資帳，當作「我的個人持股」給伴侶看。
 * 只分享勾選的部位（股數 / 均價），不分享帳戶、現金、其他資產。
 */
export function LinkPortfolioDialog({ householdId, holdings, open, onOpenChange }: LinkPortfolioDialogProps) {
  const { data: positions = [], isLoading } = usePortfolio();
  const { data: stocks = [] } = useStocks();
  const sync = useSyncLinkedPositions();
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const linkedIds = useMemo(
    () => new Set(holdings.filter((h) => h.source === 'portfolio' && h.sourcePositionId).map((h) => h.sourcePositionId as string)),
    [holdings],
  );
  const names = useMemo(() => Object.fromEntries(stocks.map((s) => [s.symbol, s.name])), [stocks]);
  const activePositions = useMemo(() => positions.filter((p) => p.shares > 0), [positions]);

  useEffect(() => {
    if (!open) return;
    setSelected(Object.fromEntries(activePositions.map((p) => [p.id, linkedIds.has(p.id)])));
  }, [open, activePositions, linkedIds]);

  const chosen = activePositions.filter((p) => selected[p.id]);

  async function handleSave() {
    try {
      const n = await sync.mutateAsync({ householdId, positions: chosen, existing: holdings, names });
      toast.success(n ? `已連結 / 同步 ${n} 檔` : '沒有選擇任何部位');
      onOpenChange(false);
    } catch (err) {
      console.error('[linkPortfolio]', err);
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => { if (!sync.isPending) onOpenChange(next); }}
      title="連結我的投資組合"
      description="勾選要讓伴侶看到的部位，會以「我的個人持股」出現在共同投資帳，股數與均價每天自動同步"
      contentClassName="sm:max-w-lg"
      footer={(
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="h-12 flex-1" onClick={() => onOpenChange(false)} disabled={sync.isPending}>取消</Button>
          <Button type="button" className="h-12 flex-[2]" onClick={() => void handleSave()} disabled={sync.isPending || chosen.length === 0}>
            {sync.isPending ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
            連結並同步 {chosen.length} 檔
          </Button>
        </div>
      )}
    >
      {isLoading ? <Skeleton className="h-32" /> : activePositions.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">投資頁還沒有持倉。</p>
      ) : (
        <div className="space-y-2">
          <ul className="divide-y rounded-lg border">
            {activePositions.map((p) => (
              <li key={p.id}>
                <label className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{p.symbol}</span>
                    <span className="ml-1.5 text-muted-foreground">{names[p.symbol] ?? ''}</span>
                    <span className="block text-xs tabular-nums text-muted-foreground">
                      {p.shares.toLocaleString('en-US')} 股 · 均價 {p.avgCost.toFixed(2)} · 成本 {formatCurrency(p.shares * p.avgCost, p.currency)}
                    </span>
                  </span>
                  <Switch
                    checked={selected[p.id] === true}
                    onCheckedChange={(v) => setSelected({ ...selected, [p.id]: v })}
                    aria-label={`連結 ${p.symbol}`}
                  />
                </label>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            取消勾選不會刪除已連結的持股；要移除請在共同投資的持股列表刪除。伴侶只看得到這些部位的股數、均價與損益。
          </p>
        </div>
      )}
    </ResponsiveDialog>
  );
}
