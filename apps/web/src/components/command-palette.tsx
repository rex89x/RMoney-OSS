import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  HeartHandshake,
  Home, Wallet, TrendingUp, DollarSign, Plane, Settings, Search,
  Plus, RefreshCw, Download, Bell, Receipt, Keyboard, LineChart,
  Landmark, Inbox, CalendarRange, MessageCircleQuestion, Wallet as WalletIcon,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator,
} from '@/components/ui/command';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { callAppsScript } from '@/lib/apps-script';
import { useQuickEntryStore } from '@/stores/quick-entry-store';
import { useAskStore } from '@/stores/ask-store';
import { useStocks } from '@/features/investments/hooks';
import { useTrips } from '@/features/trips/hooks';
import { useTransactions } from '@/features/ledger/hooks';
import { formatTW, startOfTWDay } from '@/lib/tz';
import { formatCurrency } from '@/lib/utils';
import { useHotkeys } from '@/hooks/use-hotkeys';

interface Props {
  onOpenCheatsheet: () => void;
}

export function CommandPalette({ onOpenCheatsheet }: Props) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const openEntry = useQuickEntryStore((s) => s.openDialog);
  const openAsk = useAskStore((s) => s.openAsk);

  const { data: stocks = [] } = useStocks();
  const { data: trips = [] } = useTrips();
  const [query, setQuery] = useState('');
  const txStart = useMemo(() => startOfTWDay(new Date(Date.now() - 90 * 86400000)), []);
  const { data: recentTxs = [] } = useTransactions({ startDate: txStart, limit: 2000 }, { enabled: open });
  const txMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return recentTxs
      .filter((t) => !t.deletedAt && (
        (t.note ?? '').toLowerCase().includes(q)
        || t.category.toLowerCase().includes(q)
        || t.paymentMethod.toLowerCase().includes(q)
        || String(Math.round(t.amountTWD)) === q
      ))
      .slice(0, 8);
  }, [recentTxs, query]);

  const pageHotkeys = useMemo(
    () => [
      { combo: 'cmd+k', description: '開啟指令面板', handler: () => setOpen((v) => !v) },
      { combo: 'ctrl+k', description: '開啟指令面板', handler: () => setOpen((v) => !v) },
      { combo: '/', description: '開啟搜尋', handler: () => setOpen(true) },
      { combo: 'n', description: '新增支出', handler: () => openEntry('expense') },
      { combo: 'shift+n', description: '新增收入', handler: () => openEntry('income') },
      { combo: '?', description: '顯示快捷鍵說明', handler: onOpenCheatsheet },
      { combo: 'g d', description: '到首頁', handler: () => navigate('/dashboard') },
      { combo: 'g x', description: '到需要處理', handler: () => navigate('/inbox') },
      { combo: 'g l', description: '到記帳', handler: () => navigate('/ledger') },
      { combo: 'g h', description: '到共同帳本', handler: () => navigate('/shared') },
      { combo: 'g i', description: '到投資', handler: () => navigate('/investments') },
      { combo: 'g f', description: '到匯率', handler: () => navigate('/fx') },
      { combo: 'g n', description: '到淨值', handler: () => navigate('/net-worth') },
      { combo: 'g t', description: '到出遊', handler: () => navigate('/trips') },
      { combo: 'g s', description: '到設定', handler: () => navigate('/settings') },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigate],
  );
  useHotkeys(pageHotkeys);

  // ESC 關閉
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open]);

  function run(fn: () => void | Promise<void>) {
    setOpen(false);
    void Promise.resolve(fn()).catch((err) => {
      toast.error(err instanceof Error ? err.message : '操作失敗');
    });
  }

  async function refreshStocks() {
    await callAppsScript('updateStockPrices');
    void qc.invalidateQueries({ queryKey: ['stocks'] });
    toast.success('已觸發股價更新');
  }
  async function refreshFx() {
    await callAppsScript('updateFxRates');
    void qc.invalidateQueries({ queryKey: ['fx-rates'] });
    toast.success('已觸發匯率更新');
  }
  async function backfillCandles() {
    await callAppsScript('backfillCandles', undefined, { scope: 'all', months: 12, days: 365, range: '1y' });
    toast.success('K 線回填完成');
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="p-0 max-w-xl overflow-hidden">
        <Command>
          <CommandInput placeholder="輸入指令、頁面、股票、旅程、交易備註…" autoFocus value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>沒有符合結果</CommandEmpty>

            <CommandGroup heading="頁面">
              <CommandItem onSelect={() => run(() => navigate('/dashboard'))}>
                <Home className="size-4" /> 首頁
                <span className="ml-auto text-xs text-muted-foreground">G D</span>
              </CommandItem>
              <CommandItem onSelect={() => run(() => navigate('/inbox'))}>
                <Inbox className="size-4" /> 需要處理
                <span className="ml-auto text-xs text-muted-foreground">G X</span>
              </CommandItem>
              <CommandItem onSelect={() => run(() => navigate('/ledger'))}>
                <Wallet className="size-4" /> 記帳
                <span className="ml-auto text-xs text-muted-foreground">G L</span>
              </CommandItem>
              <CommandItem onSelect={() => run(() => navigate('/shared'))}>
                <HeartHandshake className="size-4" /> 共同帳本
                <span className="ml-auto text-xs text-muted-foreground">G H</span>
              </CommandItem>
              <CommandItem onSelect={() => run(() => navigate('/investments'))}>
                <TrendingUp className="size-4" /> 投資
                <span className="ml-auto text-xs text-muted-foreground">G I</span>
              </CommandItem>
              <CommandItem onSelect={() => run(() => navigate('/fx'))}>
                <DollarSign className="size-4" /> 匯率
                <span className="ml-auto text-xs text-muted-foreground">G F</span>
              </CommandItem>
              <CommandItem onSelect={() => run(() => navigate('/net-worth'))}>
                <Landmark className="size-4" /> 淨值
                <span className="ml-auto text-xs text-muted-foreground">G N</span>
              </CommandItem>
              <CommandItem onSelect={() => run(() => navigate('/review'))}>
                <CalendarRange className="size-4" /> 年度回顧
              </CommandItem>
              <CommandItem onSelect={() => run(() => navigate('/trips'))}>
                <Plane className="size-4" /> 出遊
                <span className="ml-auto text-xs text-muted-foreground">G T</span>
              </CommandItem>
              <CommandItem onSelect={() => run(() => navigate('/settings'))}>
                <Settings className="size-4" /> 設定
                <span className="ml-auto text-xs text-muted-foreground">G S</span>
              </CommandItem>
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading="動作">
              <CommandItem onSelect={() => run(() => openAsk())}>
                <MessageCircleQuestion className="size-4" /> 問一下（自然語言查帳）
              </CommandItem>
              <CommandItem onSelect={() => run(() => openEntry('expense'))}>
                <Plus className="size-4" /> 新增支出
                <span className="ml-auto text-xs text-muted-foreground">N</span>
              </CommandItem>
              <CommandItem onSelect={() => run(() => openEntry('income'))}>
                <Receipt className="size-4" /> 新增收入
                <span className="ml-auto text-xs text-muted-foreground">⇧N</span>
              </CommandItem>
              <CommandItem onSelect={() => run(refreshStocks)}>
                <RefreshCw className="size-4" /> 更新股價
              </CommandItem>
              <CommandItem onSelect={() => run(refreshFx)}>
                <RefreshCw className="size-4" /> 更新匯率
              </CommandItem>
              <CommandItem onSelect={() => run(backfillCandles)}>
                <Download className="size-4" /> 回填 K 線（1 年）
              </CommandItem>
              <CommandItem onSelect={() => run(() => navigate('/settings?tab=notifications'))}>
                <Bell className="size-4" /> 通知設定
              </CommandItem>
              <CommandItem onSelect={() => run(onOpenCheatsheet)}>
                <Keyboard className="size-4" /> 鍵盤快捷鍵
                <span className="ml-auto text-xs text-muted-foreground">?</span>
              </CommandItem>
            </CommandGroup>

            {stocks.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="股票">
                  {stocks.slice(0, 10).map((s) => (
                    <CommandItem
                      key={s.symbol}
                      value={`${s.symbol} ${s.name}`}
                      onSelect={() => run(() => navigate(`/investments/${encodeURIComponent(s.symbol)}`))}
                    >
                      <LineChart className="size-4" />
                      <span className="font-medium">{s.symbol}</span>
                      <span className="text-muted-foreground">{s.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {txMatches.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="交易（近 90 天）">
                  {txMatches.map((t) => (
                    <CommandItem
                      key={t.id}
                      value={`tx ${t.note ?? ''} ${t.category} ${t.paymentMethod} ${Math.round(t.amountTWD)} ${t.id}`}
                      onSelect={() => run(() => navigate(`/ledger?tx_q=${encodeURIComponent((t.note ?? t.category).slice(0, 40))}`))}
                    >
                      <WalletIcon className="size-4" />
                      <span className="font-medium truncate">{t.note || t.category}</span>
                      <span className="text-muted-foreground text-xs">{formatTW(t.date, 'MM/dd')} · {t.paymentMethod}</span>
                      <span className="ml-auto tabular-nums text-xs">{t.type === 'income' ? '+' : '-'}{formatCurrency(t.amountTWD)}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {trips.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="出遊">
                  {trips.slice(0, 10).map((t) => (
                    <CommandItem
                      key={t.id}
                      value={`${t.name} ${t.destination.join(' ')}`}
                      onSelect={() => run(() => navigate(`/trips/${t.id}`))}
                    >
                      <Plane className="size-4" />
                      <span className="font-medium">{t.name}</span>
                      <span className="text-muted-foreground">{t.destination.join(', ')}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
        <div className="border-t bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          <Search className="inline size-3 mr-1" />
          ⌘K 開啟 · Enter 執行 · Esc 關閉
        </div>
      </DialogContent>
    </Dialog>
  );
}
