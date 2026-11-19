import { useMemo, useState } from 'react';
import { Plus, Trash2, BellRing } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Combobox } from '@/components/ui/combobox';
import { useConfirm } from '@/components/ui/confirm';
import { formatTW } from '@/lib/tz';
import { formatNumber } from '@/lib/utils';
import { useAlerts, useCreateAlert, useDeleteAlert, useUpdateAlert } from '../hooks';
import { ALERT_METRIC_LABEL, ALERT_METRICS_WITHOUT_THRESHOLD, describeAlert, type AlertMetric } from '../types';
import { useStocks } from '@/features/investments/hooks';

export function StockAlerts() {
  const { data: alerts = [] } = useAlerts();
  const { data: stocks = [] } = useStocks();
  const create = useCreateAlert();
  const update = useUpdateAlert();
  const del = useDeleteAlert();
  const confirm = useConfirm();

  async function handleDelete(id: string, label: string) {
    const ok = await confirm({
      title: '刪除警報',
      description: `${label} — 刪除後不會再觸發 Telegram 通知`,
      confirmText: '刪除',
    });
    if (ok) await del.mutateAsync(id);
  }

  const [symbol, setSymbol] = useState('');
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [threshold, setThreshold] = useState('');
  const [cooldown, setCooldown] = useState('60');
  const [oneShot, setOneShot] = useState(false);
  const [metric, setMetric] = useState<AlertMetric>('price');
  const needsThreshold = !ALERT_METRICS_WITHOUT_THRESHOLD.includes(metric);
  const needsDirection = !ALERT_METRICS_WITHOUT_THRESHOLD.includes(metric);
  const [marketTab, setMarketTab] = useState<'all' | 'TW' | 'US'>('all');

  const stockAlerts = alerts.filter((a) => a.type === 'stock');
  const stockMap = useMemo(() => Object.fromEntries(stocks.map((s) => [s.symbol, s])), [stocks]);
  const filteredAlerts = useMemo(() => {
    if (marketTab === 'all') return stockAlerts;
    return stockAlerts.filter((a) => stockMap[a.target]?.market === marketTab);
  }, [stockAlerts, stockMap, marketTab]);
  const stockOptions = useMemo(() => stocks.map((s) => ({
    value: s.symbol,
    label: `${s.symbol} · ${s.name}`,
    description: `${s.market} · ${formatNumber(s.currentPrice, 2)} ${s.currency}`,
  })), [stocks]);
  const counts = useMemo(() => ({
    tw: stockAlerts.filter((a) => stockMap[a.target]?.market === 'TW').length,
    us: stockAlerts.filter((a) => stockMap[a.target]?.market === 'US').length,
  }), [stockAlerts, stockMap]);

  async function handleCreate() {
    const t = needsThreshold ? parseFloat(threshold) : 0;
    if (!symbol || (needsThreshold && Number.isNaN(t))) return;
    await create.mutateAsync({
      type: 'stock',
      target: symbol.toUpperCase(),
      direction: metric === 'high52w' ? 'above' : metric === 'low52w' ? 'below' : direction,
      threshold: t,
      metric,
      active: true,
      cooldownMinutes: parseInt(cooldown, 10) || 60,
      oneShot,
    });
    setThreshold('');
    setSymbol('');
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>新增股價警報</CardTitle>
          <p className="text-xs text-muted-foreground">
            均線 / 52 週高低用日 K 計算（需先回填 K 線）；距成本與持倉佔比只對 Portfolio 內的標的有效。盤中每 15 分鐘檢查一次。
          </p>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-6">
          <div>
            <Label>代號</Label>
            <Combobox
              value={symbol}
              onChange={setSymbol}
              options={stockOptions}
              placeholder="選擇股票"
              searchPlaceholder="搜尋代號或名稱…"
              emptyText="無對應股票"
            />
          </div>
          <div>
            <Label>指標</Label>
            <Select value={metric} onValueChange={(v) => { setMetric(v as AlertMetric); if (v === 'ma' && !threshold) setThreshold('60'); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(ALERT_METRIC_LABEL) as AlertMetric[]).map((m) => (
                  <SelectItem key={m} value={m}>{ALERT_METRIC_LABEL[m]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>方向</Label>
            <Select value={direction} onValueChange={(v) => setDirection(v as 'above' | 'below')} disabled={!needsDirection}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="above">{metric === 'ma' ? '站上' : '高於'}</SelectItem>
                <SelectItem value="below">{metric === 'ma' ? '跌破' : '低於'}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>
              {metric === 'ma' ? '均線天數' : metric === 'vsCost' || metric === 'weight' ? '門檻（%）' : metric === 'rsi14' ? '門檻（0–100）' : '門檻'}
            </Label>
            {metric === 'ma' ? (
              <Select value={threshold || '60'} onValueChange={setThreshold}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['5', '10', '20', '60', '120', '200'].map((n) => <SelectItem key={n} value={n}>{n} 日</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <Input
                type="number"
                step="0.01"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                disabled={!needsThreshold}
                placeholder={needsThreshold ? '' : '不需要'}
              />
            )}
          </div>
          <div>
            <Label>冷卻 (分)</Label>
            <Input type="number" value={cooldown} onChange={(e) => setCooldown(e.target.value)} disabled={oneShot} />
            <div className="mt-2 flex items-center gap-2">
              <Switch id="stock-alert-once" checked={oneShot} onCheckedChange={setOneShot} />
              <Label htmlFor="stock-alert-once" className="text-xs font-normal">只通知一次</Label>
            </div>
          </div>
          <div className="flex items-end">
            <Button onClick={handleCreate} disabled={create.isPending || !symbol || (needsThreshold && !threshold)}>
              <Plus className="size-4" /> 新增
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>警報清單</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Tabs value={marketTab} onValueChange={(v) => setMarketTab(v as 'all' | 'TW' | 'US')}>
            <TabsList>
              <TabsTrigger value="all">全部 · {stockAlerts.length}</TabsTrigger>
              <TabsTrigger value="TW">台股 · {counts.tw}</TabsTrigger>
              <TabsTrigger value="US">美股 · {counts.us}</TabsTrigger>
            </TabsList>
            <TabsContent value={marketTab}>
              {filteredAlerts.length === 0 ? (
                <EmptyState icon={BellRing} title={stockAlerts.length === 0 ? '尚無股價警報' : '此市場尚無警報'} description="設定到價時 Telegram 通知" />
              ) : (
                <ul className="divide-y rounded-xl border">
                  {filteredAlerts.map((a) => {
                    const s = stockMap[a.target];
                    return (
                      <li key={a.id} className="flex items-center gap-3 p-3 text-sm">
                        <div className="flex-1">
                          <div className="font-medium">
                            {s && (
                              <span className="mr-1.5 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                {s.market}
                              </span>
                            )}
                            {describeAlert(a)}
                            {s ? <span className="ml-2 text-xs text-muted-foreground">現價 {formatNumber(s.currentPrice, 2)}</span> : null}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {a.oneShot ? '一次性' : `冷卻 ${a.cooldownMinutes} 分`}
                            {a.lastTriggeredAt ? ` · 上次觸發 ${formatTW(a.lastTriggeredAt, 'MM-dd HH:mm')}` : ''}
                          </div>
                        </div>
                        <Switch
                          checked={a.active}
                          onCheckedChange={(v) => void update.mutateAsync({ id: a.id, patch: { active: v } })}
                        />
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => void handleDelete(a.id, describeAlert(a))}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
