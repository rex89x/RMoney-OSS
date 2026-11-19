import { useEffect, useMemo, useState } from 'react';
import { ClipboardCopy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { useAllItineraryItems, useItineraryDays } from '@/features/itinerary/hooks';
import { useActiveHousehold } from '@/features/household/hooks';
import { useCategories, useTransactions } from '@/features/ledger/hooks';
import { computeSettlement } from '../settlement';
import {
  buildExpenses,
  buildRMoneyTripBundle,
  buildStops,
  commonChiaumingTripKey,
  defaultPersonChoice,
  peopleInDetails,
  settlementInputs,
  type PersonChoice,
} from '../export-chiauming';
import type { Trip } from '../types';

interface ChiaumingExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trip: Trip;
}

const CHOICE_LABEL: Record<PersonChoice, string> = { ming: '明', chiau: '巧', other: '其他旅伴（不匯入）' };

export function ChiaumingExportDialog({ open, onOpenChange, trip }: ChiaumingExportDialogProps) {
  const { user } = useAuth();
  const household = useActiveHousehold();
  const { data: days = [] } = useItineraryDays(open ? trip.id : undefined);
  const { data: groups = [], isLoading: itemsLoading } = useAllItineraryItems(open ? trip.id : undefined, days.map((day) => day.id));
  const { data: txs = [], isLoading: txLoading } = useTransactions({ tripId: trip.id }, { enabled: open });
  const { data: categories = [] } = useCategories();

  const [includeStops, setIncludeStops] = useState(true);
  const [includeExpenses, setIncludeExpenses] = useState(true);
  const [choices, setChoices] = useState<Record<string, PersonChoice>>({});

  const myUid = user?.uid ?? '';
  const partnerUids = useMemo(() => (household?.memberIds ?? []).filter((uid) => uid !== myUid), [household, myUid]);

  const details = useMemo(() => {
    if (!myUid) return [];
    const input = settlementInputs({ members: trip.members, txs: txs.filter((tx) => !tx.deletedAt), myUid, partnerUids });
    return computeSettlement(input.members, input.txs, { householdMemberIds: [] }).transactionDetails;
  }, [trip.members, txs, myUid, partnerUids]);
  const people = useMemo(() => peopleInDetails(details), [details]);

  // 打開時套用預設對應（自己 = 明、共同帳本另一位 = 巧）
  useEffect(() => {
    if (!open) return;
    setChoices(Object.fromEntries(people.map((person) => [person.id, defaultPersonChoice(person, myUid, partnerUids)])));
  }, [open, people, myUid, partnerUids]);

  const stops = useMemo(() => buildStops(trip.id, groups.map((group) => ({
    dayId: group.dayId,
    date: days.find((day) => day.id === group.dayId)?.date,
    items: group.items,
  }))), [trip.id, groups, days]);
  const expenseResult = useMemo(() => buildExpenses({
    details,
    txById: new Map(txs.map((tx) => [tx.id, tx])),
    choices,
    categories,
  }), [details, txs, choices, categories]);

  const bundle = useMemo(() => buildRMoneyTripBundle({
    trip,
    stops: includeStops ? stops : [],
    expenses: includeExpenses ? expenseResult.expenses : [],
    chiaumingTripKey: commonChiaumingTripKey(groups.flatMap((group) => group.items)),
  }), [trip, stops, includeStops, includeExpenses, expenseResult.expenses, groups]);
  // 先把 JSON 算好，按下就同步寫剪貼簿（iOS Safari 在 await 之後會拒絕寫入）
  const json = useMemo(() => JSON.stringify(bundle), [bundle]);
  const linked = stops.filter((stop) => stop.mapsUrl || stop.lat != null).length;
  const loading = itemsLoading || txLoading;
  const nothing = bundle.stops.length === 0 && bundle.expenses.length === 0;
  const expenseTotal = expenseResult.expenses.reduce((sum, expense) => sum + expense.amount, 0);

  function copy(): void {
    navigator.clipboard.writeText(json).then(
      () => toast.success('已複製，到巧明日常旅程頁按「從 RMoney 匯入」貼上'),
      (err: unknown) => {
        console.error('[chiaumingExport.copy]', err);
        toast.error('瀏覽器不允許寫入剪貼簿');
      },
    );
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="複製到巧明日常"
      description="把這趟的行程（含地圖連結與座標）和巧明兩人的花費複製成一份資料，到巧明日常貼上；重複貼同一趟是更新，不會重複。"
      footer={(
        <Button className="w-full sm:w-auto" onClick={copy} disabled={loading || nothing}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <ClipboardCopy className="size-4" />}
          複製（{bundle.stops.length} 個停留點・{bundle.expenses.length} 筆花費）
        </Button>
      )}
    >
      <div className="space-y-4 text-sm">
        <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <span>
            <span className="font-medium">行程</span>
            <span className="block text-xs text-muted-foreground">{stops.length} 個項目，其中 {linked} 個有地圖連結或座標</span>
          </span>
          <Switch checked={includeStops} onCheckedChange={setIncludeStops} aria-label="包含行程" />
        </label>

        <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <span>
            <span className="font-medium">花費</span>
            <span className="block text-xs text-muted-foreground">
              {expenseResult.expenses.length} 筆，巧明合計 NT${expenseTotal.toLocaleString()}（只算兩人負擔的部分，換算台幣）
            </span>
          </span>
          <Switch checked={includeExpenses} onCheckedChange={setIncludeExpenses} aria-label="包含花費" />
        </label>

        {includeExpenses && people.length > 0 ? (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="font-medium">誰是誰</div>
            {people.map((person) => (
              <label key={person.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{person.id === myUid ? `${person.name}（我）` : person.name}</span>
                <select
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={choices[person.id] ?? 'other'}
                  onChange={(event) => setChoices((prev) => ({ ...prev, [person.id]: event.target.value as PersonChoice }))}
                  aria-label={`${person.name} 對應到`}
                >
                  {(['ming', 'chiau', 'other'] as const).map((value) => (
                    <option key={value} value={value}>{CHOICE_LABEL[value]}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        ) : null}

        {includeExpenses && expenseResult.skipped.length > 0 ? (
          <div className="space-y-1 rounded-lg border border-dashed p-3">
            <div className="flex items-center gap-2 font-medium">
              略過 <Badge variant="outline">{expenseResult.skipped.length}</Badge>
            </div>
            <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
              {expenseResult.skipped.map((item) => (
                <li key={item.txId}>{item.title}：{item.reason}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </ResponsiveDialog>
  );
}
