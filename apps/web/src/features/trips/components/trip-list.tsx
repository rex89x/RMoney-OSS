import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ClipboardPaste, Plus, Plane, Sparkles, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DatePicker } from '@/components/ui/date-picker';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/utils';
import { dateInputToTWDate, formatDateInput, formatTW, parseDateInput } from '@/lib/tz';
import {
  DataTablePagination, DataTableToolbar, useDataTable, type FilterDef,
} from '@/components/data-table';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import type { Trip } from '../types';
import { useCreateTrip, useTrips } from '../hooks';
import { useActiveHousehold } from '@/features/household/hooks';
import { householdTripMembers } from '../known-companions';
import { applyTemplate } from '../apply-template';
import { TemplatePicker } from './template-picker';
import { ChiaumingImportDialog } from './chiauming-import-dialog';
import { AiItineraryImportDialog } from '@/features/itinerary/components/ai-itinerary-import-dialog';

export function TripList() {
  const { user } = useAuth();
  const { data: trips = [], isLoading } = useTrips();
  const create = useCreateTrip();
  const household = useActiveHousehold();
  // 共同帳本設定「新旅程自動分享給伴侶」→ 建立時直接帶 sharedWith
  const autoSharedWith = household?.autoShareTrips
    ? household.memberIds.filter((id) => id !== user?.uid)
    : [];
  // 自動分享時，共同帳本成員（含自己）直接成為旅程成員，之後的共同支出才算得到兩人身上
  const autoMembers = household?.autoShareTrips ? householdTripMembers(household) : [];
  const autoTripFields = {
    ...(autoSharedWith.length > 0 ? { sharedWith: autoSharedWith } : {}),
    ...(autoMembers.length > 0 ? { members: autoMembers } : {}),
  };
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [budget, setBudget] = useState('');
  const [foreign, setForeign] = useState('USD');
  const [searchParams, setSearchParams] = useSearchParams();
  const [importOpen, setImportOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  // 巧明日常「開啟 RMoney 貼上」帶 ?import=chiauming 過來時直接打開匯入對話框。
  useEffect(() => {
    if (searchParams.get('import') !== 'chiauming') return;
    setImportOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('import');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const filters: FilterDef[] = useMemo(() => [
    {
      id: 'status',
      label: '狀態',
      kind: 'select',
      options: [
        { value: 'planning', label: 'Planning' },
        { value: 'active', label: 'Active' },
        { value: 'done', label: 'Done' },
      ],
    },
    { id: 'startDate', label: '出發', kind: 'dateRange' },
  ], []);

  const accessor = useMemo(() => (row: Trip, id: string) => {
    switch (id) {
      case 'status': return row.status;
      case 'startDate': return row.startDate;
      case 'name': return row.name;
      case 'destination': return Array.isArray(row.destination) ? row.destination.join(' ') : row.destination;
      case 'notes': return row.notes ?? '';
      default: return (row as unknown as Record<string, unknown>)[id];
    }
  }, []);

  const table = useDataTable<Trip>({
    data: trips,
    accessor,
    searchFields: ['name', 'destination', 'notes'],
    filters,
    pageSize: 12,
    urlKey: 'trip',
  });

  async function handleCreate() {
    if (!name || !startDate || !endDate) return;
    const parsedStart = dateInputToTWDate(startDate);
    const parsedEnd = dateInputToTWDate(endDate);
    if (!parsedStart || !parsedEnd) {
      toast.error('請選擇有效日期');
      return;
    }
    await create.mutateAsync({
      trip: {
        name,
        destination: destination.split(',').map((x) => x.trim()).filter(Boolean),
        startDate: parsedStart,
        endDate: parsedEnd,
        baseCurrency: 'TWD',
        foreignCurrencies: [foreign],
        budget: parseFloat(budget) || 0,
        status: 'planning',
        ...autoTripFields,
      },
    });
    setName('');
    setDestination('');
    setStartDate('');
    setEndDate('');
    setBudget('');
  }

  async function handleCreateFromTemplate(tpl: import('../templates').TripTemplate, tplStart: Date) {
    if (!user) return;
    const startYmd = formatDateInput(tplStart);
    const endD = new Date(tplStart);
    endD.setDate(endD.getDate() + tpl.days - 1);
    const endYmd = formatDateInput(endD);
    const parsedStart = dateInputToTWDate(startYmd);
    const parsedEnd = dateInputToTWDate(endYmd);
    if (!parsedStart || !parsedEnd) {
      toast.error('模板日期無效');
      return;
    }
    const tripId = await create.mutateAsync({
      trip: {
        name: `${tpl.name} ${startYmd}`,
        destination: tpl.destinations,
        startDate: parsedStart,
        endDate: parsedEnd,
        baseCurrency: tpl.baseCurrency,
        foreignCurrencies: tpl.foreignCurrencies,
        budget: tpl.estimatedBudgetTWD,
        status: 'planning',
        ...autoTripFields,
      },
    });
    if (tripId) {
      try {
        await applyTemplate({
          tripId,
          userId: user.uid,
          template: tpl,
          startDate: tplStart,
        });
        toast.success('行程已從模板建立');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '建立行程表失敗');
      }
    }
  }

  return (
    <div className="space-y-4">
      <ChiaumingImportDialog open={importOpen} onOpenChange={setImportOpen} autoSharedWith={autoSharedWith} />
      <AiItineraryImportDialog open={aiOpen} onOpenChange={setAiOpen} autoSharedWith={autoSharedWith} />
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <CardTitle>新增出遊</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setAiOpen(true)}>
              <Wand2 className="size-4" /> AI 匯入行程
            </Button>
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
              <ClipboardPaste className="size-4" /> 從巧明日常匯入
            </Button>
            <TemplatePicker
              trigger={
                <Button size="sm" variant="outline">
                  <Sparkles className="size-4" /> 從模板建立
                </Button>
              }
              onSelect={handleCreateFromTemplate}
            />
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-6">
          <div className="md:col-span-2">
            <Label>名稱</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bali 2026/05" />
          </div>
          <div className="md:col-span-2">
            <Label>目的地 (逗號分隔)</Label>
            <Input value={destination} onChange={(e) => setDestination(e.target.value)} />
          </div>
          <div>
            <Label>起</Label>
            <DatePicker
              value={parseDateInput(startDate)}
              onChange={(d) => setStartDate(d ? formatDateInput(d) : '')}
              clearable={false}
            />
          </div>
          <div>
            <Label>訖</Label>
            <DatePicker
              value={parseDateInput(endDate)}
              onChange={(d) => setEndDate(d ? formatDateInput(d) : '')}
              clearable={false}
            />
          </div>
          <div>
            <Label>預算 (TWD)</Label>
            <Input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </div>
          <div>
            <Label>外幣</Label>
            <Input value={foreign} onChange={(e) => setForeign(e.target.value.toUpperCase())} />
          </div>
          <div className="flex items-end">
            <Button onClick={handleCreate} disabled={create.isPending}>
              <Plus className="size-4" /> 建立
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">載入中…</p>
      ) : trips.length === 0 ? (
        <EmptyState icon={Plane} title="尚無出遊" description="開始規劃下一趟行程" />
      ) : (
        <div className="space-y-3">
          <DataTableToolbar table={table} searchPlaceholder="搜尋名稱、目的地、備註…" />
          {table.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">沒有符合條件的出遊</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {table.rows.map((t) => (
                <Link key={t.id} to={`/trips/${t.id}`}>
                  <Card className="transition-colors hover:border-primary/50">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="text-base font-semibold">{t.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {formatTW(t.startDate, 'yyyy/MM/dd')} ~ {formatTW(t.endDate, 'MM/dd')}
                          </div>
                        </div>
                        <Badge variant={t.status === 'active' ? 'success' : 'secondary'}>
                          {t.status}
                        </Badge>
                      </div>
                      <div className="mt-3 text-sm text-muted-foreground">
                        {t.destination.join(' · ')}
                      </div>
                      <div className="mt-3 text-sm">
                        預算 {formatCurrency(t.budget)}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
          <DataTablePagination table={table} />
        </div>
      )}
    </div>
  );
}
