import { useState } from 'react';
import { Loader2, RefreshCw, Zap, Send, Database, Bell, LineChart, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { doc, setDoc, Timestamp } from 'firebase/firestore';
import { toast } from 'sonner';
import { db } from '@/lib/firebase';
import { callAppsScript } from '@/lib/apps-script';
import {
  DEFAULT_CATEGORIES, TRIP_CATEGORIES, SEED_TW_STOCKS, SEED_US_STOCKS,
} from '@/lib/seed-data';
import { cn } from '@/lib/utils';

type Step = 'idle' | 'running' | 'ok' | 'error';

interface ActionState {
  step: Step;
  message?: string;
}

export function BootstrapPanel() {
  const [seedCats, setSeedCats] = useState<ActionState>({ step: 'idle' });
  const [seedStocks, setSeedStocks] = useState<ActionState>({ step: 'idle' });
  const [updatePrices, setUpdatePrices] = useState<ActionState>({ step: 'idle' });
  const [updateFx, setUpdateFx] = useState<ActionState>({ step: 'idle' });
  const [testTg, setTestTg] = useState<ActionState>({ step: 'idle' });
  const [backfill, setBackfill] = useState<ActionState>({ step: 'idle' });
  const [triggers, setTriggers] = useState<ActionState>({ step: 'idle' });

  async function runSeedCategories() {
    setSeedCats({ step: 'running' });
    try {
      const all = [...DEFAULT_CATEGORIES, ...TRIP_CATEGORIES];
      await Promise.all(
        all.map((c) =>
          setDoc(doc(db, 'categories', c.key), {
            ...c,
            archivedAt: null,
          }, { merge: true }),
        ),
      );
      setSeedCats({ step: 'ok', message: `${all.length} 筆類別已建立` });
      toast.success('類別 seed 完成');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSeedCats({ step: 'error', message: msg });
      toast.error(`類別 seed 失敗：${msg}`);
    }
  }

  async function runSeedStocks() {
    setSeedStocks({ step: 'running' });
    try {
      const tw = SEED_TW_STOCKS.map((s) => ({ symbol: s, market: 'TW' as const, currency: 'TWD' as const }));
      const us = SEED_US_STOCKS.map((s) => ({ symbol: s, market: 'US' as const, currency: 'USD' as const }));
      const all = [...tw, ...us];
      await Promise.all(
        all.map((s) =>
          setDoc(doc(db, 'stocks', s.symbol), {
            symbol: s.symbol,
            market: s.market,
            currency: s.currency,
            name: s.symbol,
            currentPrice: 0,
            prevClose: 0,
            change: 0,
            changePercent: 0,
            high: 0,
            low: 0,
            open: 0,
            volume: 0,
            updatedAt: Timestamp.fromDate(new Date()),
          }, { merge: true }),
        ),
      );
      setSeedStocks({ step: 'ok', message: `${all.length} 檔股票 placeholder 已建立` });
      toast.success('股票 seed 完成');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSeedStocks({ step: 'error', message: msg });
      toast.error(`股票 seed 失敗：${msg}`);
    }
  }

  async function runUpdatePrices() {
    setUpdatePrices({ step: 'running' });
    try {
      const resp = await callAppsScript<{ updated?: number; total?: number }>('updateStockPrices');
      setUpdatePrices({
        step: 'ok',
        message: `更新 ${resp.updated ?? '?'} / ${resp.total ?? '?'} 檔`,
      });
      toast.success('股價更新完成');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setUpdatePrices({ step: 'error', message: msg });
      toast.error(`股價更新失敗：${msg}`);
    }
  }

  async function runUpdateFx() {
    setUpdateFx({ step: 'running' });
    try {
      await callAppsScript('updateFxRates');
      setUpdateFx({ step: 'ok', message: '匯率已更新' });
      toast.success('匯率更新完成');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setUpdateFx({ step: 'error', message: msg });
      toast.error(`匯率更新失敗：${msg}`);
    }
  }

  async function runBackfillCandles() {
    setBackfill({ step: 'running' });
    try {
      const resp = await callAppsScript<{ wrote?: Record<string, unknown> }>(
        'backfillCandles',
        undefined,
        { scope: 'all', months: 12, days: 365, range: '1y' },
      );
      const wrote = resp.wrote ?? {};
      const total = Object.values(wrote).reduce<number>((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);
      setBackfill({ step: 'ok', message: `已寫入 ${total} 筆 K 線（${Object.keys(wrote).length} 個目標）` });
      toast.success('K 線回填完成');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBackfill({ step: 'error', message: msg });
      toast.error(`回填失敗：${msg}`);
    }
  }

  async function runTestTelegram() {
    setTestTg({ step: 'running' });
    try {
      await callAppsScript('sendTest');
      setTestTg({ step: 'ok', message: '已發送測試訊息 — 請檢查 Telegram' });
      toast.success('Telegram 測試訊息已發送');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestTg({ step: 'error', message: msg });
      toast.error(`Telegram 測試失敗：${msg}`);
    }
  }

  async function runSetupTriggers() {
    setTriggers({ step: 'running' });
    try {
      const resp = await callAppsScript('setupTriggers');
      if (!resp.ok) throw new Error(resp.error ?? 'unknown');
      setTriggers({ step: 'ok', message: '已重新註冊全部定時任務' });
      toast.success('定時任務已重新註冊');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTriggers({ step: 'error', message: msg });
      toast.error(`註冊失敗：${msg}`);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>資料初始化 / 測試</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <ActionRow
          icon={Database}
          title="Seed 類別"
          desc="建立預設支出 / 收入 / 出遊類別（15+6 筆）"
          state={seedCats}
          onRun={runSeedCategories}
          label="執行"
        />
        <ActionRow
          icon={Database}
          title="Seed 股票"
          desc="建立預設 TW + US 股票 placeholder（20 檔）"
          state={seedStocks}
          onRun={runSeedStocks}
          label="執行"
        />
        <ActionRow
          icon={RefreshCw}
          title="更新股價"
          desc="觸發 Apps Script 去抓 TWSE + Finnhub"
          state={updatePrices}
          onRun={runUpdatePrices}
          label="更新"
        />
        <ActionRow
          icon={Zap}
          title="更新匯率"
          desc="觸發 Apps Script 去抓 open.er-api"
          state={updateFx}
          onRun={runUpdateFx}
          label="更新"
        />
        <ActionRow
          icon={Send}
          title="測試 Telegram"
          desc="檢查 Apps Script → Telegram Bot 的連線"
          state={testTg}
          onRun={runTestTelegram}
          label="發送"
        />
        <ActionRow
          icon={LineChart}
          title="回填 K 線（1 年）"
          desc="拉所有股票 + 4 組主要匯率的日 K 歷史，供技術分析"
          state={backfill}
          onRun={runBackfillCandles}
          label="回填"
        />
        <ActionRow
          icon={Clock}
          title="重新註冊排程"
          desc="Apps Script 新增或修改 trigger 後按一次；會清掉舊的再全部重建"
          state={triggers}
          onRun={runSetupTriggers}
          label="註冊"
        />
        <div className="flex flex-col justify-center rounded-xl border border-dashed p-4 text-sm text-muted-foreground md:col-span-2">
          <div className="flex items-center gap-2">
            <Bell className="size-4" />
            <span className="font-medium text-foreground">Tip</span>
          </div>
          <p className="mt-1">
            首次使用：先 Seed 類別 + Seed 股票 → 更新股價 + 更新匯率 → 測試 Telegram。
            完成後按「重新註冊排程」啟動定時更新。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ActionRow({
  icon: Icon,
  title,
  desc,
  state,
  onRun,
  label,
}: {
  icon: typeof Database;
  title: string;
  desc: string;
  state: ActionState;
  onRun: () => void | Promise<void>;
  label: string;
}) {
  const toneClass =
    state.step === 'ok'
      ? 'text-success'
      : state.step === 'error'
      ? 'text-destructive'
      : 'text-muted-foreground';

  return (
    <div className="flex items-start gap-3 rounded-xl border bg-card p-4">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
        {state.message ? (
          <div className={cn('mt-1 text-xs', toneClass)}>{state.message}</div>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={state.step === 'running'}
        onClick={() => void onRun()}
      >
        {state.step === 'running' ? (
          <Loader2 className="size-4 animate-spin" />
        ) : null}
        {label}
      </Button>
    </div>
  );
}
