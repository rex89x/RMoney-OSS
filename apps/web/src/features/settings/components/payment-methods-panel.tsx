import { useState } from 'react';
import { CreditCard, Wallet, Smartphone, Banknote, MoreHorizontal, Plus, Trash2, Bell } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { useConfirm } from '@/components/ui/confirm';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  TYPE_LABEL, paymentMethodLabel, useArchivePaymentMethod, usePaymentMethods, useUpsertPaymentMethod,
  type PaymentMethod, type PaymentMethodType,
} from '@/features/ledger/payment-methods';

const TYPE_ICON: Record<PaymentMethodType, typeof Wallet> = {
  cash: Banknote,
  credit: CreditCard,
  debit: CreditCard,
  mobile: Smartphone,
  other: MoreHorizontal,
};

const PRESET_COLORS = ['#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#ef4444', '#06b6d4', '#64748b'];

export function PaymentMethodsPanel() {
  const { data: methods = [], isLoading } = usePaymentMethods();
  const upsert = useUpsertPaymentMethod();
  const archive = useArchivePaymentMethod();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<PaymentMethod | null>(null);
  const [open, setOpen] = useState(false);

  function startNew() {
    setEditing({
      id: '',
      key: `pm_${Date.now().toString(36)}`,
      name: '',
      type: 'credit',
      color: PRESET_COLORS[methods.length % PRESET_COLORS.length],
      order: methods.length,
    });
    setOpen(true);
  }

  function startEdit(p: PaymentMethod) {
    setEditing({ ...p });
    setOpen(true);
  }

  async function handleSave() {
    if (!editing) return;
    if (!editing.name.trim()) { toast.error('請輸入名稱'); return; }
    const isCardLike = editing.type === 'credit' || editing.type === 'debit';
    const billingEnabled = isCardLike && !!editing.billingEnabled;
    if (billingEnabled) {
      const dueDay = editing.dueDay ?? 0;
      if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
        toast.error('請輸入 1–31 之間的繳款截止日');
        return;
      }
      if (editing.statementDay != null) {
        const sd = editing.statementDay;
        if (!Number.isInteger(sd) || sd < 1 || sd > 31) {
          toast.error('結帳日請輸入 1–31');
          return;
        }
      }
    }
    try {
      await upsert.mutateAsync({
        key: editing.key,
        name: editing.name.trim(),
        type: editing.type,
        bank: editing.bank?.trim() || undefined,
        last4: editing.last4?.trim() || undefined,
        color: editing.color,
        icon: editing.icon,
        order: editing.order ?? 999,
        archivedAt: null,
        billingEnabled,
        statementDay: billingEnabled ? (editing.statementDay ?? null) : null,
        dueDay: billingEnabled ? (editing.dueDay ?? null) : null,
      });
      toast.success('已儲存');
      setOpen(false);
      setEditing(null);
    } catch (err) {
      console.error('[paymentMethodSave]', err);
      toast.error(err instanceof Error ? err.message : '支付方式儲存失敗');
    }
  }

  async function handleArchive(p: PaymentMethod) {
    const ok = await confirm({
      title: '封存此支付方式？',
      description: `${paymentMethodLabel(p)} 之後新增交易時不會再出現在選單，但已存在的紀錄不變。`,
      confirmText: '封存',
    });
    if (!ok) return;
    try {
      await archive.mutateAsync(p.id);
      toast.success('已封存');
    } catch (err) {
      console.error('[paymentMethodArchive]', err);
      toast.error(err instanceof Error ? err.message : '支付方式封存失敗');
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="size-4" /> 支付方式
          </CardTitle>
          <Button size="sm" variant="outline" onClick={startNew}>
            <Plus className="size-4" /> 新增
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中…</p>
          ) : methods.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              尚未自訂任何支付方式 — 系統會 fallback 到預設清單（現金/信用卡/Line Pay/Apple Pay）。
              建議建立你常用的卡片，便於統計時一眼分辨。
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {methods.map((p) => {
                const Icon = TYPE_ICON[p.type] ?? MoreHorizontal;
                return (
                  <li key={p.id} className="flex items-center gap-3 p-3 text-sm">
                    <span
                      className="flex size-9 shrink-0 items-center justify-center rounded-full"
                      style={{ backgroundColor: (p.color ?? '#94a3b8') + '20', color: p.color ?? '#94a3b8' }}
                    >
                      <Icon className="size-4" />
                    </span>
                    <button
                      type="button"
                      onClick={() => startEdit(p)}
                      className="min-w-0 flex-1 cursor-pointer text-left"
                    >
                      <div className="truncate font-medium">{p.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {TYPE_LABEL[p.type]}
                        {p.bank ? ` · ${p.bank}` : ''}
                        {p.last4 ? ` · ****${p.last4}` : ''}
                      </div>
                    </button>
                    <Badge variant="outline">{TYPE_LABEL[p.type]}</Badge>
                    <Button size="icon-sm" variant="ghost" onClick={() => void handleArchive(p)} aria-label="封存">
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
        open={open}
        onOpenChange={(o) => { if (!o) { setOpen(false); setEditing(null); } }}
        title={editing && methods.find((m) => m.id === editing.id) ? '編輯支付方式' : '新增支付方式'}
        description="信用卡可填銀行 + 末四碼，方便對帳"
        footer={
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setOpen(false)}>取消</Button>
            <Button className="flex-1" onClick={() => void handleSave()} disabled={upsert.isPending || !editing?.name?.trim()}>
              儲存
            </Button>
          </div>
        }
      >
        {editing && (
          <div className="space-y-3">
            <div>
              <Label>名稱</Label>
              <Input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="玉山 Pi 卡 / Line Pay / 現金"
                autoFocus
              />
            </div>
            <div>
              <Label>類型</Label>
              <Select value={editing.type} onValueChange={(v) => setEditing({ ...editing, type: v as PaymentMethodType })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(TYPE_LABEL) as PaymentMethodType[]).map((t) => (
                    <SelectItem key={t} value={t}>{TYPE_LABEL[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(editing.type === 'credit' || editing.type === 'debit') && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>銀行（選填）</Label>
                    <Input
                      value={editing.bank ?? ''}
                      onChange={(e) => setEditing({ ...editing, bank: e.target.value })}
                      placeholder="玉山 / 中信 / 國泰"
                    />
                  </div>
                  <div>
                    <Label>末四碼（選填）</Label>
                    <Input
                      value={editing.last4 ?? ''}
                      onChange={(e) => setEditing({ ...editing, last4: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                      placeholder="1234"
                      maxLength={4}
                    />
                  </div>
                </div>

                <div className="rounded-lg border p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Bell className="size-4" /> 帳單提醒
                    </div>
                    <Switch
                      checked={!!editing.billingEnabled}
                      onCheckedChange={(v) => setEditing({ ...editing, billingEnabled: v })}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    啟用後，繳款截止日當天起會經 Telegram 每日提醒，直到於「帳單」頁標記已繳費。
                  </p>
                  {editing.billingEnabled && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>結帳日（選填）</Label>
                        <Input
                          type="number"
                          min={1}
                          max={31}
                          inputMode="numeric"
                          value={editing.statementDay ?? ''}
                          onChange={(e) => {
                            const v = e.target.value;
                            setEditing({
                              ...editing,
                              statementDay: v === '' ? null : Math.max(1, Math.min(31, Number(v))),
                            });
                          }}
                          placeholder="例：5"
                        />
                      </div>
                      <div>
                        <Label>繳款截止日</Label>
                        <Input
                          type="number"
                          min={1}
                          max={31}
                          inputMode="numeric"
                          value={editing.dueDay ?? ''}
                          onChange={(e) => {
                            const v = e.target.value;
                            setEditing({
                              ...editing,
                              dueDay: v === '' ? null : Math.max(1, Math.min(31, Number(v))),
                            });
                          }}
                          placeholder="例：25"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
            <div>
              <Label>顏色</Label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setEditing({ ...editing, color: c })}
                    className={cn(
                      'size-7 rounded-full border-2 transition-transform',
                      editing.color === c ? 'scale-110 ring-2 ring-offset-2 ring-offset-background' : 'border-transparent',
                    )}
                    style={{ backgroundColor: c, borderColor: c }}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </ResponsiveDialog>
    </>
  );
}
