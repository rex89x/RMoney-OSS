import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Star, Plus, Trash2, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatNumber, formatPercent } from '@/lib/utils';
import { isTwMarketOpen, isUsMarketOpen } from '@/lib/market-hours';
import { formatTW } from '@/lib/tz';
import {
  DataTablePagination, DataTableToolbar, useDataTable, type FilterDef,
} from '@/components/data-table';
import { useConfirm } from '@/components/ui/confirm';
import {
  useAddWatchlist, useRefreshStocks, useRefreshSymbol, useRemoveWatchlist, useStocks, useWatchlist,
} from '../hooks';
import { inferCurrency, inferMarket, normalizeStockSymbol } from '../symbol-utils';
import type { Stock } from '../types';

type MarketTab = 'all' | 'TW' | 'US';

export function WatchlistView() {
  const { data: stocks = [], isLoading } = useStocks();
  const { data: watchlist = [] } = useWatchlist();
  const refresh = useRefreshStocks();
  const refreshOne = useRefreshSymbol();
  const add = useAddWatchlist();
  const remove = useRemoveWatchlist();
  const confirm = useConfirm();
  const [newSymbol, setNewSymbol] = useState('');
  const [marketTab, setMarketTab] = useState<MarketTab>('all');

  async function handleRemove(symbol: string) {
    const ok = await confirm({
      title: '從追蹤清單移除',
      description: `要把 ${symbol} 從 Watchlist 移除嗎？`,
      confirmText: '移除',
    });
    if (ok) await remove.mutateAsync(symbol);
  }

  const symbolsTracked = useMemo(() => new Set(watchlist.map((w) => w.symbol)), [watchlist]);
  // watchlist 有但 stocks 還沒抓到價的，補成 placeholder Stock 顯示在最上面
  // （否則使用者剛加完什麼都看不到，會以為加入失敗）
  const stocksWithPlaceholders = useMemo(() => {
    const stockSymbols = new Set(stocks.map((s) => s.symbol));
    const placeholders: Stock[] = watchlist
      .filter((w) => !stockSymbols.has(w.symbol))
      .map((w) => ({
        id: w.symbol,
        symbol: w.symbol,
        market: inferMarket(w.symbol),
        name: '抓取中…',
        currency: inferCurrency(w.symbol),
        currentPrice: 0,
        prevClose: 0,
        change: 0,
        changePercent: 0,
        high: 0,
        low: 0,
        open: 0,
        volume: 0,
        updatedAt: null,
      }));
    return [...stocks, ...placeholders];
  }, [stocks, watchlist]);

  const sorted = useMemo(() => {
    return [...stocksWithPlaceholders].sort((a, b) => {
      const aT = symbolsTracked.has(a.symbol) ? 0 : 1;
      const bT = symbolsTracked.has(b.symbol) ? 0 : 1;
      if (aT !== bT) return aT - bT;
      return b.changePercent - a.changePercent;
    });
  }, [stocksWithPlaceholders, symbolsTracked]);

  const marketFiltered = useMemo(
    () => marketTab === 'all' ? sorted : sorted.filter((s) => s.market === marketTab),
    [sorted, marketTab],
  );

  const counts = useMemo(() => ({
    tw: sorted.filter((s) => s.market === 'TW').length,
    us: sorted.filter((s) => s.market === 'US').length,
  }), [sorted]);

  const staleHint = useMemo(() => {
    if (sorted.length === 0) return null;
    const now = Date.now();
    const stale24h = sorted.filter((s) => !s.updatedAt || (now - s.updatedAt.getTime() > 24 * 3600 * 1000));
    if (stale24h.length / sorted.length > 0.5) {
      return `${stale24h.length} / ${sorted.length} 檔資料超過 24 小時未更新，按「更新」重新抓取`;
    }
    return null;
  }, [sorted]);

  const filters: FilterDef[] = useMemo(() => [
    {
      id: 'watching',
      label: '追蹤',
      kind: 'select',
      options: [
        { value: 'yes', label: '已追蹤' },
        { value: 'no', label: '未追蹤' },
      ],
    },
    {
      id: 'trend',
      label: '趨勢',
      kind: 'select',
      options: [
        { value: 'up', label: '上漲' },
        { value: 'down', label: '下跌' },
      ],
    },
  ], []);
  void marketTab;

  const accessor = useMemo(() => (row: Stock, id: string) => {
    switch (id) {
      case 'symbol': return row.symbol;
      case 'name': return row.name;
      case 'market': return row.market;
      case 'watching': return symbolsTracked.has(row.symbol) ? 'yes' : 'no';
      case 'trend': return row.change >= 0 ? 'up' : 'down';
      default: return (row as unknown as Record<string, unknown>)[id];
    }
  }, [symbolsTracked]);

  const table = useDataTable<Stock>({
    data: marketFiltered,
    accessor,
    searchFields: ['symbol', 'name'],
    filters,
    pageSize: 50,
    urlKey: 'wl',
  });

  async function handleAdd() {
    const norm = normalizeStockSymbol(newSymbol);
    if (!norm.ok) {
      toast.error(norm.reason);
      return;
    }
    if (symbolsTracked.has(norm.symbol)) {
      toast.message(`${norm.symbol} 已在 Watchlist`);
      setNewSymbol('');
      return;
    }
    await add.mutateAsync({ symbol: norm.symbol });
    if (norm.twInfo && norm.twInfo.kind !== 'stock') {
      toast.message(`${norm.symbol} 判斷為${norm.twInfo.label}${norm.twInfo.foreignCurrency ? '，以外幣（USD）計價' : ''}`);
    }
    setNewSymbol('');
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <CardTitle>Watchlist</CardTitle>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <Badge variant={isTwMarketOpen() ? 'success' : 'secondary'}>
              TW {isTwMarketOpen() ? 'OPEN' : 'CLOSED'}
            </Badge>
            <Badge variant={isUsMarketOpen() ? 'success' : 'secondary'}>
              US {isUsMarketOpen() ? 'OPEN' : 'CLOSED'}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refresh.mutateAsync()}
              disabled={refresh.isPending}
            >
              <RefreshCw className={refresh.isPending ? 'size-4 animate-spin' : 'size-4'} />
              更新
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="新增代號 (例如 2330 或 AAPL)"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
              className="flex-1"
            />
            <Button onClick={() => void handleAdd()} disabled={add.isPending}>
              <Plus className="size-4" /> 追蹤
            </Button>
          </div>

          {staleHint && (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
              {staleHint}
            </div>
          )}

          <Tabs value={marketTab} onValueChange={(v) => setMarketTab(v as MarketTab)}>
            <TabsList>
              <TabsTrigger value="all">全部 · {sorted.length}</TabsTrigger>
              <TabsTrigger value="TW">台股 · {counts.tw}</TabsTrigger>
              <TabsTrigger value="US">美股 · {counts.us}</TabsTrigger>
            </TabsList>
          </Tabs>

          <DataTableToolbar
            table={table}
            searchPlaceholder="搜尋代號或名稱…"
          />

          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中…</p>
          ) : sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚未初始化，請先執行 Apps Script seedAll()</p>
          ) : table.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">沒有符合條件的股票</p>
          ) : (
            <ul className="divide-y rounded-xl border">
              {table.rows.map((s) => {
                const isTracked = symbolsTracked.has(s.symbol);
                const positive = s.change >= 0;
                return (
                  <li key={s.symbol} className="flex items-center gap-2 p-3 text-sm sm:gap-3">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() =>
                        isTracked
                          ? void handleRemove(s.symbol)
                          : void add.mutateAsync({ symbol: s.symbol })
                      }
                      aria-label="toggle watch"
                    >
                      <Star
                        className={isTracked ? 'size-4 fill-current text-yellow-500' : 'size-4 text-muted-foreground'}
                      />
                    </Button>
                    <div className="min-w-0 flex-1">
                      <Link to={`/investments/${encodeURIComponent(s.symbol)}`} className="font-medium">
                        {s.symbol}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {s.market} · {s.name}
                        {s.updatedAt ? ` · ${formatTW(s.updatedAt, 'HH:mm')}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="text-right">
                        {s.updatedAt ? (
                          <>
                            <div className="font-medium tabular-nums">{formatNumber(s.currentPrice, 2)}</div>
                            <div className={positive ? 'text-xs text-success' : 'text-xs text-destructive'}>
                              {formatPercent(s.changePercent)}
                            </div>
                          </>
                        ) : (
                          <div className="text-xs text-muted-foreground italic">抓取中…</div>
                        )}
                      </div>
                      {!s.updatedAt && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            void refreshOne.mutateAsync(s.symbol);
                          }}
                          disabled={refreshOne.isPending}
                          aria-label="retry"
                          title="重抓"
                        >
                          <RotateCw className={refreshOne.isPending ? 'size-3.5 animate-spin' : 'size-3.5'} />
                        </Button>
                      )}
                    </div>
                    {isTracked ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => void handleRemove(s.symbol)}
                        aria-label="remove"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <DataTablePagination table={table} />
        </CardContent>
      </Card>
    </div>
  );
}
