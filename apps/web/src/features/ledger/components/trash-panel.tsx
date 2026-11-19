import { Trash2, Undo2, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { useConfirm } from '@/components/ui/confirm';
import { formatCurrency } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import {
  useDeletedTransactions, useHardDeleteTransaction, useRestoreTransaction,
} from '../hooks';

export function TrashPanel() {
  const { data: deleted = [], isLoading } = useDeletedTransactions(7);
  const restore = useRestoreTransaction();
  const hardDelete = useHardDeleteTransaction();
  const confirm = useConfirm();

  async function handleRestore(id: string) {
    await restore.mutateAsync(id);
  }
  async function handleHardDelete(id: string, label: string) {
    const ok = await confirm({
      title: '永久刪除？',
      description: `${label} — 此動作無法復原`,
      confirmText: '永久刪除',
    });
    if (ok) await hardDelete.mutateAsync(id);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Trash2 className="size-4" /> 回收筒
          <Badge variant="outline" className="ml-2">{deleted.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          7 天內被刪除的交易，可復原。超過 7 天的紀錄會由排程自動永久刪除。
        </p>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中…</p>
        ) : deleted.length === 0 ? (
          <EmptyState icon={Wallet} title="沒有 7 天內刪除的交易" />
        ) : (
          <ul className="divide-y rounded-md border">
            {deleted.map((t) => {
              const ageMs = t.deletedAt ? Date.now() - t.deletedAt.getTime() : 0;
              const daysLeft = Math.max(0, Math.ceil((7 * 86400000 - ageMs) / 86400000));
              const label = `${t.category} ${t.type === 'income' ? '+' : '-'}${Math.round(t.amountTWD)} TWD${t.note ? ` · ${t.note}` : ''}`;
              return (
                <li key={t.id} className="flex items-center gap-3 p-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{t.note || t.category}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatTW(t.date, 'yyyy/MM/dd')} · {t.paymentMethod}
                      {t.deletedAt && (
                        <> · 刪於 {formatTW(t.deletedAt, 'MM/dd HH:mm')}</>
                      )}
                      {' · '}
                      <span className={daysLeft <= 1 ? 'text-destructive' : ''}>
                        剩 {daysLeft} 天
                      </span>
                    </div>
                  </div>
                  <div className={t.type === 'income' ? 'shrink-0 font-medium text-success tabular-nums' : 'shrink-0 font-medium tabular-nums'}>
                    {t.type === 'expense' ? '-' : '+'}{formatCurrency(t.amountTWD)}
                  </div>
                  <Button
                    size="icon-sm"
                    variant="outline"
                    onClick={() => void handleRestore(t.id)}
                    disabled={restore.isPending}
                    title="復原"
                  >
                    <Undo2 className="size-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => void handleHardDelete(t.id, label)}
                    disabled={hardDelete.isPending}
                    title="永久刪除"
                    className="text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
