import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/ui/empty-state';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useConfirm } from '@/components/ui/confirm';
import { AccountSelect, currencyToTwdRate, useAccounts } from '@/features/accounts';
import { useFxRates } from '@/features/fx/hooks';
import { useCostBasisMethod, useDeletePortfolio, useExecutePortfolioTrade, usePortfolio, useStocks } from '../hooks';
import { canUseFifo, COST_BASIS_LABEL, DEFAULT_COST_BASIS_METHOD } from '../cost-basis';
import { formatCurrency, formatNumber, formatPercent, sum } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { normalizeStockSymbol } from '../symbol-utils';
import type { Market } from '../types';

type MarketTab = 'all' | 'TW' | 'US';

export function PortfolioView() {
  const { data: positions = [] } = usePortfolio();
  const { data: stocks = [] } = useStocks();
  const trade = useExecutePortfolioTrade();
  const del = useDeletePortfolio();
  const confirm = useConfirm();
  const { data: fxRates = [] } = useFxRates();
  const { data: accounts = [] } = useAccounts();
  const { data: costBasisMethod = DEFAULT_COST_BASIS_METHOD } = useCostBasisMethod();

  async function handleDelete(id: string, symbol: string) {
    const ok = await confirm({
      title: '刪除整個持倉',
      description: `${symbol} 連同所有買賣紀錄會一併刪除。此動作無法復原。`,
      confirmText: '刪除',
    });
    if (ok) await del.mutateAsync(id);
  }

  const stockMap = useMemo(
    () => Object.fromEntries(stocks.map((s) => [s.symbol, s])),
    [stocks],
  );

  const [tab, setTab] = useState<MarketTab>('all');
  const [symbol, setSymbol] = useState('');
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState<'TWD' | 'USD'>('TWD');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [tradeAccountId, setTradeAccountId] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (tradeAccountId) return;
    const first = accounts.find((account) => ['bank', 'cash', 'investment_cash', 'e_wallet_balance'].includes(account.type));
    setTradeAccountId(first?.id ?? '');
  }, [accounts, tradeAccountId]);

  // 選到已知股票時自動帶入 currency / 現價
  useEffect(() => {
    if (!symbol) return;
    const normalized = normalizeStockSymbol(symbol);
    if (!normalized.ok) return;
    const s = stockMap[normalized.symbol];
    if (s) {
      setCurrency(s.currency);
      if (!price) setPrice(String(s.currentPrice));
      return;
    }
    // 外幣交易 ETF（如 K 字尾）也是 USD，交給共用規則判斷
    setCurrency(normalized.currency);
  }, [symbol, stockMap, price]);

  const stockOptions: ComboboxOption[] = useMemo(
    () => stocks.map((s) => ({
      value: s.symbol,
      label: `${s.symbol} · ${s.name}`,
      description: `${s.market} · ${formatNumber(s.currentPrice, 2)} ${s.currency}`,
    })),
    [stocks],
  );

  async function handleAdd() {
    if (!symbol || !shares || !price || !tradeAccountId) {
      toast.error('請完整填寫股票、股數、價格與帳戶');
      return;
    }
    const normalized = normalizeStockSymbol(symbol);
    if (!normalized.ok) {
      toast.error(normalized.reason);
      return;
    }
    const sh = parseFloat(shares);
    const pr = parseFloat(price);
    const existing = positions.find((p) => p.symbol === normalized.symbol);
    if (!Number.isFinite(sh) || sh <= 0 || !Number.isFinite(pr) || pr <= 0) {
      toast.error('股數與價格必須大於 0');
      return;
    }
    if (side === 'sell' && !existing) {
      toast.error('找不到可賣出的持倉');
      return;
    }
    if (side === 'sell' && existing && sh > existing.shares) {
      toast.error('賣出股數超過持有股數');
      return;
    }

    const tradeCurrency = side === 'sell' && existing ? existing.currency : currency;
    const fxRate = currencyToTwdRate(tradeCurrency, fxRates);
    const selectedAccount = accounts.find((account) => account.id === tradeAccountId);
    const selectedAccountFxRate = selectedAccount ? currencyToTwdRate(selectedAccount.currency, fxRates) : 1;
    await trade.mutateAsync({
      side,
      symbol: normalized.symbol,
      shares: sh,
      price: pr,
      currency: tradeCurrency,
      fxRate,
      accountFxRate: selectedAccountFxRate,
      accountId: tradeAccountId,
      existingPositionId: existing?.id,
      market: (stockMap[normalized.symbol]?.market ?? normalized.market) as Market,
      costBasisMethod: side === 'sell' ? costBasisMethod : undefined,
    });

    setSymbol('');
    setShares('');
    setPrice('');
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const enriched = useMemo(() => {
    return positions.map((p) => {
      const s = stockMap[p.symbol];
      const current = s?.currentPrice ?? p.avgCost;
      const marketValue = current * p.shares;
      const cost = p.avgCost * p.shares;
      const pnl = marketValue - cost;
      const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
      const twdRate = currencyToTwdRate(p.currency, fxRates);
      // 推斷 market：以 stocks 文件為主，fallback 用 currency（USD → US）
      const market: Market = (s?.market) ?? (p.currency === 'USD' ? 'US' : 'TW');
      return {
        ...p,
        market,
        current,
        marketValue,
        marketValueTWD: marketValue * twdRate,
        cost,
        costTWD: cost * twdRate,
        twdRate,
        pnl,
        pnlPct,
        dayChange: s?.change ?? 0,
        dayChangePercent: s?.changePercent ?? 0,
      };
    });
  }, [positions, stockMap, fxRates]);

  const filtered = tab === 'all' ? enriched : enriched.filter((p) => p.market === tab);

  const sellPosition = side === 'sell' ? positions.find((p) => p.symbol === symbol) : undefined;
  const fifoFallback = costBasisMethod === 'fifo' && sellPosition ? !canUseFifo(sellPosition) : false;

  const totals = useMemo(() => ({
    all: aggregate(enriched),
    tw: aggregate(enriched.filter((p) => p.market === 'TW')),
    us: aggregate(enriched.filter((p) => p.market === 'US')),
  }), [enriched]);
  const current = tab === 'TW' ? totals.tw : tab === 'US' ? totals.us : totals.all;

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={(v) => setTab(v as MarketTab)}>
        <TabsList>
          <TabsTrigger value="all">全部</TabsTrigger>
          <TabsTrigger value="TW">台股 · {totals.tw.count}</TabsTrigger>
          <TabsTrigger value="US">美股 · {totals.us.count}</TabsTrigger>
        </TabsList>

        <TabsContent value={tab} className="space-y-4">
          <Card>
            <CardHeader><CardTitle>總覽（{tabLabel(tab)}）</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="總市值 (TWD)" value={formatCurrency(current.marketValueTWD)} />
              <Stat label="總成本 (TWD)" value={formatCurrency(current.costTWD)} />
              <Stat
                label="總損益"
                value={`${formatCurrency(current.marketValueTWD - current.costTWD)} · ${formatPercent(current.pnlPct)}`}
                tone={(current.marketValueTWD - current.costTWD) >= 0 ? 'success' : 'danger'}
              />
              <Stat
                label="今日損益"
                value={formatCurrency(current.dayChangeTWD)}
                tone={current.dayChangeTWD >= 0 ? 'success' : 'danger'}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>{side === 'buy' ? '買入 / 加碼' : '賣出 / 減倉'}</span>
                <div className="flex gap-1 rounded-full bg-muted p-1 text-xs">
                  <button
                    type="button"
                    onClick={() => setSide('buy')}
                    className={`h-7 rounded-full px-3 ${side === 'buy' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
                  >買入</button>
                  <button
                    type="button"
                    onClick={() => setSide('sell')}
                    className={`h-7 rounded-full px-3 ${side === 'sell' ? 'bg-destructive text-destructive-foreground shadow-sm' : 'text-muted-foreground'}`}
                  >賣出</button>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-6">
              <div className="md:col-span-2">
                <Label>股票</Label>
                <Combobox
                  value={symbol}
                  onChange={setSymbol}
                  options={side === 'sell' ? positions.map((p) => ({ value: p.symbol, label: `${p.symbol} (持有 ${p.shares})` })) : stockOptions}
                  placeholder={side === 'sell' ? '選擇要賣的部位' : '選擇或輸入代號…'}
                  searchPlaceholder="搜尋代號或名稱…"
                  emptyText={side === 'sell' ? '無持倉可賣' : '找不到 — 輸入後可新增'}
                  allowCustom={side === 'buy'}
                />
              </div>
              <div>
                <Label>股數{side === 'sell' && symbol ? ` (持有 ${positions.find((p) => p.symbol === symbol)?.shares ?? 0})` : ''}</Label>
                <Input type="number" value={shares} onChange={(e) => setShares(e.target.value)} />
              </div>
              <div>
                <Label>{side === 'buy' ? '均價' : '賣出價'}</Label>
                <Input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
              </div>
              <div className="md:col-span-2">
                <Label>{side === 'buy' ? '扣款帳戶' : '入款帳戶'}</Label>
                <AccountSelect
                  value={tradeAccountId}
                  onValueChange={setTradeAccountId}
                  accounts={accounts}
                  types={['cash', 'bank', 'investment_cash', 'e_wallet_balance']}
                />
              </div>
              {side === 'buy' && (
                <div>
                  <Label>幣別</Label>
                  <Select value={currency} onValueChange={(v) => setCurrency(v as 'TWD' | 'USD')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="TWD">TWD</SelectItem>
                      <SelectItem value="USD">USD</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {side === 'sell' && (
                <p className="text-[11px] text-muted-foreground md:col-span-6">
                  成本計算：{COST_BASIS_LABEL[costBasisMethod]}（可在「已實現」分頁切換）
                  {fifoFallback ? (
                    <span className="block text-amber-600 dark:text-amber-400">
                      此持倉缺少完整的買進批次紀錄，這筆賣出會改用平均成本計算。
                    </span>
                  ) : null}
                </p>
              )}
              <div className="md:col-span-6">
                <Button
                  onClick={handleAdd}
                  disabled={trade.isPending || del.isPending || !tradeAccountId}
                  variant={side === 'sell' ? 'destructive' : 'default'}
                >
                  <Plus className="size-4" />
                  {side === 'buy' ? '買入' : '賣出'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {filtered.length === 0 ? (
            <EmptyState icon={Wallet} title={tab === 'all' ? '尚無持倉' : `沒有${tabLabel(tab)}持倉`} />
          ) : (
            <Card>
              <CardContent className="p-0">
                <ul className="divide-y">
                  {filtered.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => toggleExpand(p.id)}
                        className="grid w-full grid-cols-[minmax(0,1fr),auto,auto] items-center gap-3 p-3 text-left text-sm hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <div className="font-medium">
                            <span className="mr-1.5 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{p.market}</span>
                            {p.symbol}
                            <span className="ml-2 text-xs text-muted-foreground">× {formatNumber(p.shares, 0)}</span>
                          </div>
                          {/* 手機寬度放不下時換行，不用 truncate（會把「今日漲跌」整段切掉） */}
                          <div className="text-xs text-muted-foreground">
                            均價 {formatNumber(p.avgCost, 2)} {p.currency} · 現價 {formatNumber(p.current, 2)}
                            {p.dayChangePercent ? (
                              <span className={p.dayChangePercent >= 0 ? 'whitespace-nowrap text-success' : 'whitespace-nowrap text-destructive'}>
                                {' '}· 今日 {formatPercent(p.dayChangePercent)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-medium">{formatCurrency(p.marketValue, p.currency)}</div>
                          <div className={p.pnl >= 0 ? 'text-xs text-success' : 'text-xs text-destructive'}>
                            {formatPercent(p.pnlPct)}
                          </div>
                        </div>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); void handleDelete(p.id, p.symbol); }}
                          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                          aria-label="刪除持倉"
                        >
                          <Trash2 className="size-4" />
                        </span>
                      </button>
                      {expanded.has(p.id) && p.lots && p.lots.length > 0 && (
                        <div className="border-t bg-muted/20 px-3 py-2">
                          <div className="mb-1 text-[11px] font-medium text-muted-foreground">交易紀錄（{p.lots.length}）</div>
                          <ul className="space-y-1">
                            {p.lots.map((lot, i) => (
                              <li key={i} className="flex items-center justify-between text-xs tabular-nums">
                                <span>{formatTW(lot.date, 'yyyy/MM/dd')}</span>
                                <span className={lot.shares < 0 ? 'text-destructive' : 'text-success'}>
                                  {lot.shares < 0 ? '賣 ' : '買 '}{Math.abs(lot.shares)} @ {lot.price}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function aggregate(items: Array<{
  shares: number; current: number; avgCost: number; currency: 'TWD' | 'USD';
  marketValueTWD: number; costTWD: number;
  twdRate: number;
  dayChange: number;
}>) {
  const marketValueTWD = sum(items, (p) => p.marketValueTWD);
  const costTWD = sum(items, (p) => p.costTWD);
  const dayChangeTWD = sum(items, (p) => p.dayChange * p.shares * p.twdRate);
  const pnlPct = costTWD > 0 ? ((marketValueTWD - costTWD) / costTWD) * 100 : 0;
  return { count: items.length, marketValueTWD, costTWD, dayChangeTWD, pnlPct };
}

function tabLabel(t: MarketTab): string {
  return t === 'TW' ? '台股' : t === 'US' ? '美股' : '全部';
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'danger' }) {
  const toneClass = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-destructive' : '';
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}
