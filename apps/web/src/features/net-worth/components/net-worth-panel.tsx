import { useState } from 'react';
import { Building, Car, Plus, Trash2, MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { formatCurrency } from '@/lib/utils';
import { AccountsPanel } from '@/features/accounts';
import {
  useDeleteManualAsset, useManualAssets, useUpsertManualAsset,
} from '../hooks';
import {
  ASSET_TYPE_LABEL, type ManualAsset, type ManualAssetType,
} from '../types';

export function NetWorthPanel() {
  return (
    <div className="space-y-4">
      <AccountsPanel />
      <ManualAssetsSection />
    </div>
  );
}

// ---------- Manual assets ----------

function ManualAssetsSection() {
  const { data: items = [], isLoading } = useManualAssets();
  const upsert = useUpsertManualAsset();
  const del = useDeleteManualAsset();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<ManualAsset | null>(null);

  function startNew() {
    setEditing({
      id: '', name: '', type: 'real_estate', valueTWD: 0, asOf: new Date(), note: '',
      updatedAt: new Date(), createdAt: new Date(),
    });
  }

  async function handleSave() {
    if (!editing) return;
    if (!editing.name.trim()) { toast.error('請輸入名稱'); return; }
    try {
      await upsert.mutateAsync({
        input: {
          name: editing.name.trim(),
          type: editing.type,
          valueTWD: editing.valueTWD,
          asOf: editing.asOf,
          note: editing.note?.trim() || null,
        },
        id: editing.id || undefined,
      });
      toast.success('已儲存');
      setEditing(null);
    } catch (err) {
      console.error('[manualAssetSave]', err);
      toast.error(err instanceof Error ? err.message : '資產儲存失敗');
    }
  }

  async function handleDelete(a: ManualAsset) {
    const ok = await confirm({ title: '刪除資產？', description: a.name, confirmText: '刪除' });
    if (!ok) return;
    try {
      await del.mutateAsync(a.id);
      toast.success('已刪除');
    } catch (err) {
      console.error('[manualAssetDelete]', err);
      toast.error(err instanceof Error ? err.message : '資產刪除失敗');
    }
  }

  const ICON: Record<ManualAssetType, typeof Building> = {
    real_estate: Building,
    vehicle: Car,
    collectible: MoreHorizontal,
    other: MoreHorizontal,
  };
  const total = items.reduce((s, a) => s + (a.valueTWD || 0), 0);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building className="size-4" /> 手動資產（房 / 車 / 其他）
          </CardTitle>
          <Button size="sm" variant="outline" onClick={startNew}><Plus className="size-4" /> 新增</Button>
        </CardHeader>
        <CardContent>
          <p className="mb-2 text-xs text-muted-foreground">合計 {formatCurrency(total)}</p>
          {isLoading ? <p className="text-sm text-muted-foreground">載入中…</p> : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚未建立任何資產</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {items.map((a) => {
                const Icon = ICON[a.type] ?? MoreHorizontal;
                return (
                  <li key={a.id} className="flex items-center gap-3 p-3 text-sm">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing({ ...a })}>
                      <div className="truncate font-medium">{a.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{ASSET_TYPE_LABEL[a.type]}</div>
                    </button>
                    <div className="text-right text-sm tabular-nums">{formatCurrency(a.valueTWD)}</div>
                    <Button size="icon-sm" variant="ghost" onClick={() => void handleDelete(a)} aria-label="刪除">
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <ResponsiveDialog
        open={!!editing}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        title={editing && editing.id ? '編輯資產' : '新增資產'}
        footer={
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setEditing(null)}>取消</Button>
            <Button className="flex-1" onClick={() => void handleSave()} disabled={upsert.isPending}>儲存</Button>
          </div>
        }
      >
        {editing && (
          <div className="space-y-3">
            <div><Label>名稱</Label>
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例：信義國宅" autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>類型</Label>
                <Select value={editing.type} onValueChange={(v) => setEditing({ ...editing, type: v as ManualAssetType })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(ASSET_TYPE_LABEL) as ManualAssetType[]).map((t) => (
                      <SelectItem key={t} value={t}>{ASSET_TYPE_LABEL[t]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div><Label>估值（TWD）</Label>
                <Input type="number" inputMode="decimal" value={Number.isFinite(editing.valueTWD) ? editing.valueTWD : ''}
                  onChange={(e) => setEditing({ ...editing, valueTWD: Number(e.target.value) })} />
              </div>
            </div>
            <div><Label>估價日期</Label>
              <DatePicker value={editing.asOf} onChange={(d) => d && setEditing({ ...editing, asOf: d })} clearable={false} />
            </div>
            <div><Label>備註</Label>
              <Input value={editing.note ?? ''} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
            </div>
          </div>
        )}
      </ResponsiveDialog>
    </>
  );
}
