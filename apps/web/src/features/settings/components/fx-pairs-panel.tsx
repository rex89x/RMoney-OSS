import { useState } from 'react';
import { DollarSign, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useConfirm } from '@/components/ui/confirm';
import {
  useDeleteFxPair, useFxPairs, useToggleFxPair, useUpsertFxPair,
} from '@/features/fx/hooks';

export function FxPairsPanel() {
  const { data: pairs = [] } = useFxPairs();
  const upsert = useUpsertFxPair();
  const toggle = useToggleFxPair();
  const del = useDeleteFxPair();
  const confirm = useConfirm();

  async function handleDelete(id: string) {
    const ok = await confirm({
      title: '刪除幣別',
      description: `${id} 不會再追蹤匯率變動。已存的歷史 candles 不受影響。`,
      confirmText: '刪除',
    });
    if (ok) await del.mutateAsync(id);
  }

  const [base, setBase] = useState('');
  const [quote, setQuote] = useState('TWD');

  async function handleAdd() {
    const b = base.trim().toUpperCase();
    const q = quote.trim().toUpperCase();
    if (b.length !== 3 || q.length !== 3) {
      toast.error('幣別代碼為 3 個英文字母（ISO 4217）');
      return;
    }
    if (b === q) {
      toast.error('Base 與 Quote 不可相同');
      return;
    }
    await upsert.mutateAsync({ base: b, quote: q });
    setBase('');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="size-4" /> 匯率幣別
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          新增的幣別會被 Apps Script 的「更新匯率」與「回填 K 線」自動納入（資料源 open.er-api / currency-api，僅支援它們有的貨幣）。
        </p>

        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <Label>Base</Label>
            <Input
              placeholder="USD / EUR / JPY..."
              value={base}
              onChange={(e) => setBase(e.target.value.toUpperCase())}
              maxLength={3}
            />
          </div>
          <div>
            <Label>Quote</Label>
            <Input
              value={quote}
              onChange={(e) => setQuote(e.target.value.toUpperCase())}
              maxLength={3}
            />
          </div>
          <div className="md:col-span-2 flex items-end">
            <Button onClick={() => void handleAdd()} disabled={upsert.isPending || !base}>
              <Plus className="size-4" /> 新增幣別
            </Button>
          </div>
        </div>

        <ul className="divide-y rounded-xl border">
          {pairs.length === 0 ? (
            <li className="p-3 text-sm text-muted-foreground">尚未自訂；後端會 fallback 用預設 4 組</li>
          ) : (
            pairs.map((p) => (
              <li key={p.id} className="flex items-center gap-3 p-3 text-sm">
                <div className="flex-1 font-medium">{p.base} / {p.quote}</div>
                <Switch
                  checked={p.enabled}
                  onCheckedChange={(v) => void toggle.mutateAsync({ id: p.id, enabled: v })}
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => void handleDelete(p.id)}
                  disabled={del.isPending}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
