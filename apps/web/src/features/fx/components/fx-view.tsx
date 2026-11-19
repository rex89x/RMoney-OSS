import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, RefreshCw, BellRing } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { formatFxRate } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import {
  DataTablePagination, DataTableToolbar, useDataTable, type FilterDef,
} from '@/components/data-table';
import { useConfirm } from '@/components/ui/confirm';
import {
  useAlertLogs, useAlerts, useCreateAlert, useDeleteAlert, useFxRates, useRefreshFx, useUpdateAlert,
} from '../hooks';
import type { Alert as AlertType, AlertLog } from '../types';
import { FxChart } from './fx-chart';
import { FxRateCard } from './fx-rate-card';

export function FxView() {
  const { data: rates = [] } = useFxRates();
  const { data: alerts = [] } = useAlerts();
  const { data: logs = [] } = useAlertLogs();
  const refresh = useRefreshFx();
  const createAlert = useCreateAlert();
  const updateAlert = useUpdateAlert();
  const deleteAlert = useDeleteAlert();
  const confirm = useConfirm();

  const [pair, setPair] = useState('USD_TWD');
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [threshold, setThreshold] = useState('');
  const [cooldown, setCooldown] = useState('60');
  const [oneShot, setOneShot] = useState(false);

  const pairOptions = useMemo(() => {
    const ids = new Set<string>();
    rates.forEach((r) => ids.add(r.id));
    ids.add('USD_TWD');
    return Array.from(ids).sort();
  }, [rates]);

  const latestUpdatedAt = useMemo(() => {
    const timestamps = rates
      .map((r) => r.updatedAt?.getTime())
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (timestamps.length === 0) return null;
    return new Date(Math.max(...timestamps));
  }, [rates]);

  const isStale = latestUpdatedAt ? Date.now() - latestUpdatedAt.getTime() > 6 * 3600 * 1000 : rates.length > 0;

  useEffect(() => {
    if (!pairOptions.includes(pair)) setPair(pairOptions[0] ?? 'USD_TWD');
  }, [pair, pairOptions]);

  async function handleCreate() {
    const t = parseFloat(threshold);
    if (!Number.isFinite(t) || t <= 0) {
      toast.error('請輸入大於 0 的匯率門檻');
      return;
    }
    await createAlert.mutateAsync({
      type: 'fx',
      target: pair,
      direction,
      threshold: t,
      active: true,
      cooldownMinutes: parseInt(cooldown, 10) || 60,
      oneShot,
    });
    setThreshold('');
  }

  const fxAlerts = alerts.filter((a) => a.type === 'fx');

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <div>
            <CardTitle>即時匯率</CardTitle>
            {latestUpdatedAt ? (
              <p className={isStale ? 'text-xs text-yellow-700 dark:text-yellow-400' : 'text-xs text-muted-foreground'}>
                最近更新：{formatTW(latestUpdatedAt, 'yyyy-MM-dd HH:mm')}
                {isStale ? ' · 可能已過期' : ''}
              </p>
            ) : null}
          </div>
          <Button size="sm" variant="outline" onClick={() => void refresh.mutateAsync()} disabled={refresh.isPending}>
            <RefreshCw className={refresh.isPending ? 'size-4 animate-spin' : 'size-4'} /> 更新
          </Button>
        </CardHeader>
        <CardContent>
          {rates.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚無匯率資料</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {rates.map((r) => (
                <li key={r.id}>
                  <FxRateCard rate={r} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <FxChart rates={rates} />

      <Card>
        <CardHeader><CardTitle>新增匯率警報</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-6">
          <div>
            <Label>幣對</Label>
            <Select value={pair} onValueChange={setPair}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {pairOptions.map((id) => (
                  <SelectItem key={id} value={id}>{id.replace('_', ' / ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>方向</Label>
            <Select value={direction} onValueChange={(v) => setDirection(v as 'above' | 'below')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="above">高於</SelectItem>
                <SelectItem value="below">低於</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>門檻</Label>
            <Input
              type="number"
              step="0.0001"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </div>
          <div>
            <Label>冷卻 (分)</Label>
            <Input type="number" value={cooldown} onChange={(e) => setCooldown(e.target.value)} disabled={oneShot} />
          </div>
          <div className="flex items-end gap-2 pb-2">
            <Switch id="fx-alert-once" checked={oneShot} onCheckedChange={setOneShot} />
            <Label htmlFor="fx-alert-once" className="text-sm font-normal">只通知一次</Label>
          </div>
          <div className="flex items-end">
            <Button onClick={handleCreate} disabled={createAlert.isPending}>
              <Plus className="size-4" /> 新增
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertsCard
        alerts={fxAlerts}
        onToggle={(id, v) => void updateAlert.mutateAsync({ id, patch: { active: v } })}
        onDelete={async (id, label) => {
          const ok = await confirm({
            title: '刪除警報',
            description: `${label} — 刪除後不會再觸發 Telegram 通知`,
            confirmText: '刪除',
          });
          if (ok) await deleteAlert.mutateAsync(id);
        }}
      />

      <AlertLogsCard logs={logs} />
    </div>
  );
}

function AlertsCard({
  alerts,
  onToggle,
  onDelete,
}: {
  alerts: AlertType[];
  onToggle: (id: string, v: boolean) => void;
  onDelete: (id: string, label: string) => void;
}) {
  const filters: FilterDef[] = useMemo(() => [
    {
      id: 'active',
      label: '狀態',
      kind: 'select',
      options: [
        { value: 'true', label: '啟用中' },
        { value: 'false', label: '已停用' },
      ],
    },
    {
      id: 'direction',
      label: '方向',
      kind: 'select',
      options: [
        { value: 'above', label: '高於' },
        { value: 'below', label: '低於' },
      ],
    },
  ], []);

  const accessor = useMemo(() => (row: AlertType, id: string) => {
    switch (id) {
      case 'active': return row.active ? 'true' : 'false';
      case 'direction': return row.direction;
      case 'target': return row.target;
      case 'notes': return row.notes ?? '';
      default: return (row as unknown as Record<string, unknown>)[id];
    }
  }, []);

  const table = useDataTable<AlertType>({
    data: alerts,
    accessor,
    searchFields: ['target', 'notes'],
    filters,
    pageSize: 25,
    urlKey: 'al',
  });

  return (
    <Card>
      <CardHeader><CardTitle>警報清單</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {alerts.length > 0 && (
          <DataTableToolbar table={table} searchPlaceholder="搜尋幣對…" />
        )}
        {alerts.length === 0 ? (
          <EmptyState icon={BellRing} title="尚無警報" />
        ) : table.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">沒有符合條件的警報</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {table.rows.map((a) => (
              <li key={a.id} className="flex items-center gap-3 p-3 text-sm">
                <div className="flex-1">
                  <div className="font-medium">
                    {a.target} {a.direction === 'above' ? '>=' : '<='} {a.type === 'fx' ? formatFxRate(a.threshold) : a.threshold}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {a.oneShot ? '一次性' : `冷卻 ${a.cooldownMinutes} 分`}
                    {a.lastTriggeredAt ? ` · 上次觸發 ${formatTW(a.lastTriggeredAt, 'MM-dd HH:mm')}` : ''}
                  </div>
                </div>
                <Switch checked={a.active} onCheckedChange={(v) => onToggle(a.id, v)} />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => onDelete(a.id, `${a.target} ${a.direction === 'above' ? '>=' : '<='} ${a.threshold}`)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {alerts.length > 0 && <DataTablePagination table={table} />}
      </CardContent>
    </Card>
  );
}

function AlertLogsCard({ logs }: { logs: AlertLog[] }) {
  const filters: FilterDef[] = useMemo(() => [
    { id: 'triggeredAt', label: '期間', kind: 'dateRange' },
  ], []);

  const accessor = useMemo(() => (row: AlertLog, id: string) => {
    switch (id) {
      case 'triggeredAt': return row.triggeredAt;
      case 'alertId': return row.alertId;
      default: return (row as unknown as Record<string, unknown>)[id];
    }
  }, []);

  const table = useDataTable<AlertLog>({
    data: logs,
    accessor,
    searchFields: ['alertId'],
    filters,
    pageSize: 25,
    urlKey: 'lg',
  });

  return (
    <Card>
      <CardHeader><CardTitle>近期觸發紀錄</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {logs.length > 0 && (
          <DataTableToolbar table={table} searchPlaceholder="搜尋警報 id…" />
        )}
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">尚未有任何觸發</p>
        ) : table.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">沒有符合條件的紀錄</p>
        ) : (
          <ul className="space-y-1">
            {table.rows.map((log) => (
              <li key={log.id} className="flex items-center justify-between text-sm">
                <span>{formatTW(log.triggeredAt, 'MM-dd HH:mm')} · {log.alertId.slice(0, 8)}</span>
                <Badge variant="secondary">{log.triggerValue}</Badge>
              </li>
            ))}
          </ul>
        )}
        {logs.length > 0 && <DataTablePagination table={table} />}
      </CardContent>
    </Card>
  );
}
