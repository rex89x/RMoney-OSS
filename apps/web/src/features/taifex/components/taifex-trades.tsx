import { useMemo, useState } from 'react';
import { History, LineChart as LineChartIcon } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatGrid, StatTile } from '@/components/ui/stat-tile';
import { AXIS_PROPS, CHART_COLORS, CHART_TOOLTIP_PROPS, formatAxisTWD, paletteColor } from '@/lib/chart-theme';
import { cn } from '@/lib/utils';
import { equityChartData, tradeStats } from '../dashboard';
import { useTaifexTrades } from '../hooks';
import { EXIT_REASON_LABELS, TAIFEX_PRODUCT_SPECS, formatPoints, formatTWD, pnlClass } from '../options';
import type { TaifexAccount } from '../types';
import { TargetBadge } from './taifex-parts';

interface TaifexTradesProps {
  account: TaifexAccount;
}

/** 交易：權益曲線 + 回撤、交易統計、交易紀錄（預設只看目前這一輪帳戶） */
export function TaifexTrades({ account }: TaifexTradesProps) {
  const trades = useTaifexTrades(true);
  const [allEpochs, setAllEpochs] = useState(false);
  const curve = useMemo(() => equityChartData(account), [account]);
  const list = useMemo(
    // 策略變體的交易也在同一個 collection，這裡只看主帳戶
    () => (trades.data ?? []).filter((t) => t.accountId === account.id && (allEpochs || t.epoch === account.epoch)),
    [trades.data, allEpochs, account.epoch, account.id],
  );
  const stats = useMemo(() => tradeStats(list), [list]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><LineChartIcon className="size-4" aria-hidden /> 權益曲線</CardTitle>
          <p className="text-xs text-muted-foreground">每日收盤結算（已扣手續費、滑價、期交稅與換月成本）。</p>
        </CardHeader>
        <CardContent className="space-y-2">
          {curve.length > 1 ? (
            <>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={curve} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" />
                    <XAxis dataKey="date" {...AXIS_PROPS} tickFormatter={(v: string) => v.slice(5)} minTickGap={32} />
                    <YAxis width={48} {...AXIS_PROPS} domain={['auto', 'auto']} tickFormatter={formatAxisTWD} />
                    <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value: number) => [formatTWD(value), '權益']} />
                    <Line dataKey="equity" name="權益" stroke={paletteColor(0)} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="h-20">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={curve} margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
                    <XAxis dataKey="date" hide />
                    <YAxis width={48} {...AXIS_PROPS} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                    <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value: number) => [`${value.toFixed(2)}%`, '回撤']} />
                    <Area dataKey="drawdown" name="回撤" stroke="hsl(var(--destructive))" fill="hsl(var(--destructive) / 0.15)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">帳戶剛建立，累積幾個交易日後就會出現曲線。</p>
          )}
        </CardContent>
      </Card>

      <StatGrid>
        <StatTile label="已平倉筆數" value={stats.count} hint={allEpochs ? '全部輪次' : `第 ${account.epoch} 輪帳戶`} />
        <StatTile
          label="勝率 / 獲利因子"
          value={`${stats.winRatePct === null ? '—' : `${stats.winRatePct.toFixed(0)}%`} / ${stats.profitFactor === null ? '—' : stats.profitFactor.toFixed(2)}`}
          hint="趨勢策略勝率常低於 50%，靠賺多賠少"
        />
        <StatTile
          label="平均獲利 / 平均虧損"
          value={`${formatTWD(stats.avgWin)} / ${formatTWD(stats.avgLoss)}`}
          hint={`每筆期望值 ${formatTWD(stats.expectancy, true)}`}
        />
        <StatTile
          label="淨損益合計"
          value={formatTWD(stats.totalNet, true)}
          valueClassName={pnlClass(stats.totalNet)}
          hint={`含成本 ${formatTWD(stats.totalCosts)}，平均持有 ${stats.avgHoldingBars === null ? '—' : stats.avgHoldingBars.toFixed(1)} 天`}
        />
      </StatGrid>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <History className="size-4" aria-hidden /> 交易紀錄
            <label className="ml-auto flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
              <input type="checkbox" checked={allEpochs} onChange={(e) => setAllEpochs(e.target.checked)} className="size-3.5" />
              顯示重置前的紀錄
            </label>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {trades.isLoading ? <Skeleton className="h-32 w-full" /> : list.length ? (
            <>
            {/* 手機：卡片列表，淨損益放在第一眼看得到的位置；桌面才用完整表格 */}
            <ul className="divide-y text-xs sm:hidden">
              {list.map((t) => (
                <li key={t.id} className="flex items-center gap-2 py-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <TargetBadge target={t.side} kind="position" contracts={t.contracts} className="py-0" />
                      <span className="text-muted-foreground">{EXIT_REASON_LABELS[t.exitReason]}{t.source === 'manual' ? '・手動' : ''}{t.intraday ? '・盤中' : ''}{t.estimated ? '・推估價' : ''}</span>
                    </div>
                    <div className="tabular-nums text-muted-foreground">
                      {t.openDate.slice(5)} → {t.closeDate.slice(5)}（{t.holdingBars} 天）· {formatPoints(t.entryPrice)} → {formatPoints(t.exitPrice)}
                    </div>
                  </div>
                  <div className="text-right tabular-nums">
                    <div className={cn('font-semibold', pnlClass(t.netPnl))}>{formatTWD(t.netPnl, true)}</div>
                    <div className={cn('text-[11px]', pnlClass(t.pnlPoints))}>{formatPoints(t.pnlPoints, true)} 點</div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="-mx-1 hidden overflow-x-auto px-1 sm:block">
              <table className="w-full min-w-[640px] whitespace-nowrap text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left font-normal">方向</th>
                    <th className="text-left font-normal">進場 → 出場</th>
                    <th className="text-right font-normal">價格</th>
                    <th className="text-right font-normal">點數</th>
                    <th className="text-right font-normal">成本</th>
                    <th className="text-right font-normal">淨損益</th>
                    <th className="pl-3 text-left font-normal">原因</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {list.map((t) => (
                    <tr key={t.id} className="border-t">
                      <td className="py-1.5">
                        <TargetBadge target={t.side} kind="position" contracts={t.contracts} className="py-0" />
                        <span className="ml-1 text-[10px] text-muted-foreground">{TAIFEX_PRODUCT_SPECS[t.product].label}</span>
                      </td>
                      <td>{t.openDate.slice(5)} → {t.closeDate.slice(5)}<span className="ml-1 text-muted-foreground">{t.holdingBars} 天</span></td>
                      <td className="text-right">{formatPoints(t.entryPrice)} → {formatPoints(t.exitPrice)}</td>
                      <td className={cn('text-right', pnlClass(t.pnlPoints))}>{formatPoints(t.pnlPoints, true)}</td>
                      <td className="text-right text-muted-foreground">{formatTWD(t.costs)}</td>
                      <td className={cn('text-right font-medium', pnlClass(t.netPnl))}>{formatTWD(t.netPnl, true)}</td>
                      <td className="pl-3">{EXIT_REASON_LABELS[t.exitReason]}{t.source === 'manual' ? '（手動單）' : ''}{t.intraday ? '・盤中' : ''}{t.estimated ? '・推估價' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">還沒有已平倉的交易。</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
