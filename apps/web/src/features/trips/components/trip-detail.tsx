import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ChevronLeft, Map, Wallet, Share2, Download, CalendarDays, MapPin, Clock, FolderInput,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { ScrollTabsList } from '@/components/ui/scroll-tabs';
import { useTrip, useUpdateTrip } from '../hooks';
import { useTransactions } from '@/features/ledger/hooks';
import { useExpenseBreakdown } from '@/features/ledger/use-my-share';
import { StatGrid, StatTile } from '@/components/ui/stat-tile';
import { ViewScopeToggle, type ViewScope } from '@/components/ui/view-scope-toggle';
import { formatCurrency, formatPercent, groupBy, sum } from '@/lib/utils';
import { daysBetweenTWDates, formatTW, startOfTWDay } from '@/lib/tz';
import { useQuickEntryStore } from '@/stores/quick-entry-store';
import { useAuth } from '@/hooks/use-auth';
import { MembersPanel } from './members-panel';
import { SettlementView } from './settlement-view';
import { TripShareDialog } from './share-dialog';
import { TripBudgetVsActual } from './trip-budget-vs-actual';
import { TripOverviewMap } from './trip-overview-map';
import { ChiaumingExportDialog } from './chiauming-export-dialog';
import { TripDayCards } from './trip-day-cards';
import { TripNotesPanel } from './trip-notes-panel';
import { TripTxPicker } from './trip-tx-picker';
import { TripExpensesList } from './trip-expenses-list';
import { TripPrepaidPanel } from './trip-prepaid-panel';
import { TripDocumentsPanel } from './trip-documents-panel';
import { TripPackingPanel } from './trip-packing-panel';
import { TripReport } from './trip-report';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { exportTripCsv, exportTripMarkdown } from '../export';

export function TripDetailPage() {
  const { id = '' } = useParams();
  const { data: trip } = useTrip(id);
  const update = useUpdateTrip();
  const openEntry = useQuickEntryStore((s) => s.openDialog);
  const { user, isViewer } = useAuth();
  const isOwner = !isViewer && Boolean(trip && (trip.userId === user?.uid || trip.ownerId === user?.uid));

  const { data: txs = [] } = useTransactions({
    tripId: id,
    limit: 500,
  });

  // 幣別小卡：預設「只看我的」= 我負擔那份（原幣金額按比例縮放）；整趟總額另外算
  const breakdown = useExpenseBreakdown();
  const [viewScope, setViewScope] = useState<ViewScope>('mine');
  const [chiaumingOpen, setChiaumingOpen] = useState(false);
  const [detailTab, setDetailTab] = useState('notes');
  const byCurrency = useMemo(() => {
    const grouped = groupBy(
      txs.filter((t) => t.type === 'expense'),
      (t) => t.currency,
    );
    return Object.entries(grouped).map(([currency, items]) => ({
      currency,
      total: sum(items, (t) => {
        if (viewScope === 'all') return t.amount;
        const b = breakdown(t);
        return b.totalTWD > 0 ? t.amount * (b.shareTWD / b.totalTWD) : 0;
      }),
      totalTWD: sum(items, (t) => (viewScope === 'all' ? t.amountTWD : breakdown(t).shareTWD)),
    }));
  }, [txs, viewScope, breakdown]);

  const mine = useMemo(() => {
    let total = 0; let share = 0; let paid = 0;
    for (const t of txs) {
      if (t.type !== 'expense') continue;
      const b = breakdown(t);
      total += b.totalTWD; share += b.shareTWD; paid += b.paidTWD;
    }
    return { total, share, paid, net: paid - share };
  }, [txs, breakdown]);
  const totalTWD = mine.total;

  if (!trip) return <div className="p-6 text-muted-foreground">載入中…</div>;

  const budgetPct = trip.budget > 0 ? Math.min(100, (totalTWD / trip.budget) * 100) : 0;
  const today = startOfTWDay();
  const start = startOfTWDay(trip.startDate);
  const end = startOfTWDay(trip.endDate);
  const totalDays = Math.max(1, daysBetweenTWDates(start, end) + 1);
  const daysToStart = daysBetweenTWDates(today, start);
  const daysSinceEnd = daysBetweenTWDates(end, today);
  const countdownLabel = (() => {
    if (trip.status === 'done') return '行程已完成';
    if (today.getTime() < start.getTime()) return `出發倒數 D-${daysToStart}`;
    if (today.getTime() > end.getTime()) return `結束 ${daysSinceEnd} 天`;
    const dayNo = daysBetweenTWDates(start, today) + 1;
    return `Day ${dayNo} / ${totalDays}`;
  })();
  const statusLabel = trip.status === 'planning' ? '規劃中' : trip.status === 'active' ? '進行中' : '已完成';

  return (
    <div className="space-y-4">
      {isOwner ? <ChiaumingExportDialog open={chiaumingOpen} onOpenChange={setChiaumingOpen} trip={trip} /> : null}
      <div className="space-y-2">
        {!isViewer ? (
          <Link to="/trips" className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            <ChevronLeft className="size-4" /> 回到列表
          </Link>
        ) : null}
        {/* Action bar — 手機可水平捲動，避免擠出螢幕；桌面平鋪。 */}
        <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin] lg:flex-wrap lg:overflow-visible">
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link to={`/trips/${id}/itinerary`}>
              <Map className="size-4" /> 行程規劃
            </Link>
          </Button>
          {isOwner ? (
            <>
              <TripShareDialog
                trip={trip}
                trigger={
                  <Button variant="outline" size="sm" className="shrink-0">
                    <Share2 className="size-4" /> 分享
                    {trip.sharedWith && trip.sharedWith.length > 0 ? (
                      <Badge variant="secondary">{trip.sharedWith.length}</Badge>
                    ) : null}
                  </Button>
                }
              />
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="shrink-0"><Download className="size-4" /> 匯出</Button>
                </PopoverTrigger>
                <PopoverContent className="w-44 p-1" align="end">
                  <button
                    type="button"
                    className="block w-full rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => exportTripCsv(trip, txs)}
                  >CSV（明細）</button>
                  <button
                    type="button"
                    className="block w-full rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => exportTripMarkdown(trip, txs)}
                  >Markdown（含結算）</button>
                  <button
                    type="button"
                    className="block w-full rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => setChiaumingOpen(true)}
                  >複製到巧明日常</button>
                </PopoverContent>
              </Popover>
              <Button onClick={() => openEntry('expense', id)} size="sm" className="shrink-0">
                <Wallet className="size-4" /> 新增花費
              </Button>
            </>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 text-xs text-muted-foreground">
              你以分享身分檢視（唯讀）
            </span>
          )}
        </div>
      </div>

      <Card className="overflow-hidden">
        <div
          className={cnHero(trip.coverImage)}
          style={trip.coverImage ? { backgroundImage: `url(${JSON.stringify(trip.coverImage).slice(1, -1)})` } : undefined}
        >
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" aria-hidden />
          <div className="relative flex h-full flex-col justify-end gap-2 p-4 text-white">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="bg-white/15 text-white backdrop-blur">
                {statusLabel}
              </Badge>
              <Badge variant="secondary" className="bg-white/15 text-white backdrop-blur">
                <CalendarDays className="size-3" /> {countdownLabel}
              </Badge>
            </div>
            <h1 className="text-2xl font-semibold leading-tight md:text-3xl">{trip.name}</h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-white/90">
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" /> {trip.destination.join(' · ')}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3.5" />
                {formatTW(start, 'yyyy/MM/dd')} – {formatTW(end, 'yyyy/MM/dd')}（{totalDays} 天）
              </span>
            </div>
          </div>
        </div>
        <CardContent className="space-y-4 pt-4">
          <StatGrid>
            <StatTile label="總花費" value={formatCurrency(mine.total)} hint="整趟所有人" />
            <StatTile label="我負擔" value={formatCurrency(mine.share)} hint="分攤後我實際花的" />
            <StatTile label="我墊付" value={formatCurrency(mine.paid)} hint="我先付出去的" />
            <StatTile
              label={mine.net >= 0 ? '待收' : '待付'}
              value={formatCurrency(Math.abs(mine.net))}
              hint={Math.abs(mine.net) < 0.5 ? '已平衡' : mine.net > 0 ? '別人還要給我' : '我還要給別人'}
              tone={Math.abs(mine.net) < 0.5 ? 'plain' : mine.net > 0 ? 'good' : 'bad'}
            />
          </StatGrid>
          <div>
            <div className="mb-1 flex justify-between text-sm">
              <span>預算使用</span>
              <span>
                {formatCurrency(totalTWD)} / {formatCurrency(trip.budget)} · {formatPercent(budgetPct, 0)}
              </span>
            </div>
            <Progress value={budgetPct} />
          </div>

          {byCurrency.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">各幣別{viewScope === 'mine' ? '（我負擔）' : '（整趟）'}</span>
                <ViewScopeToggle value={viewScope} onChange={setViewScope} />
              </div>
            <div className="grid gap-2 md:grid-cols-4">
              {byCurrency.map((c) => (
                <div key={c.currency} className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">{c.currency}</div>
                  <div className="text-lg font-semibold">{Math.round(c.total).toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">
                    ≈ {formatCurrency(c.totalTWD)}
                  </div>
                </div>
              ))}
            </div>
            </div>
          )}

          {isOwner ? (
            <div className="flex gap-2">
              {trip.status !== 'active' ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void update.mutateAsync({ id, patch: { status: 'active' } })}
                >
                  開始行程
                </Button>
              ) : null}
              {trip.status !== 'done' ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void update.mutateAsync({ id, patch: { status: 'done' } })}
                >
                  標記完成
                </Button>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <TripDayCards tripId={id} />
        <TripOverviewMap tripId={id} canEdit={isOwner} destination={trip.destination.join(', ')} />
      </div>

      <Tabs value={detailTab} onValueChange={setDetailTab}>
        <ScrollTabsList
          aria-label="旅程分頁"
          value={detailTab}
          items={[
          { value: 'notes', label: '筆記' },
          { value: 'documents', label: '文件' },
          { value: 'packing', label: '行李' },
          { value: 'expenses', label: '花費' },
          { value: 'prepaid', label: '預付款' },
          { value: 'budget', label: '預算' },
          { value: 'members', label: '成員' },
          { value: 'settlement', label: '分攤結算' },
          { value: 'report', label: '報告書' },
          ]}
        />
        <TabsContent value="notes">
          <TripNotesPanel tripId={id} />
        </TabsContent>
        <TabsContent value="documents">
          <TripDocumentsPanel trip={trip} />
        </TabsContent>
        <TabsContent value="packing">
          <TripPackingPanel trip={trip} />
        </TabsContent>
        <TabsContent value="prepaid">
          <TripPrepaidPanel trip={trip} />
        </TabsContent>
        <TabsContent value="expenses" className="space-y-3">
          {isOwner ? (
            <div className="flex justify-end">
              <TripTxPicker
                trip={trip}
                trigger={
                  <Button size="sm" variant="outline">
                    <FolderInput className="size-4" /> 歸納其它消費
                  </Button>
                }
              />
            </div>
          ) : null}
          <TripExpensesList tripId={id} />
        </TabsContent>
        <TabsContent value="budget">
          <TripBudgetVsActual trip={trip} />
        </TabsContent>
        <TabsContent value="members">
          <MembersPanel trip={trip} />
        </TabsContent>
        <TabsContent value="settlement">
          <SettlementView trip={trip} />
        </TabsContent>
        <TabsContent value="report">
          <TripReport trip={trip} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function cnHero(coverImage?: string): string {
  const base = 'relative h-40 w-full bg-cover bg-center md:h-56';
  if (coverImage) return base;
  return `${base} bg-gradient-to-br from-primary/40 via-purple-500/30 to-pink-500/30`;
}
