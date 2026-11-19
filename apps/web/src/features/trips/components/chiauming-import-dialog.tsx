import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, ClipboardPaste, Loader2, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { formatTWDateInput } from '@/lib/tz';
import { rememberedTripForSource } from '@/features/ledger/paste-import-settings';
import { useImportChiaumingTrip, useTrips } from '../hooks';
import {
  matchTripByName,
  parseChiaumingTrip,
  planChiaumingImport,
  statusForDates,
  type ChiaumingImportPlan,
} from '../import-chiauming';

const NEW_TRIP = '__new__';

interface ChiaumingImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 新旅程要一併分享給的 uid（共同帳本「新旅程自動分享」設定）。 */
  autoSharedWith: string[];
}

function shortDate(value: string): string {
  return value.slice(5).replace('-', '/');
}

export function ChiaumingImportDialog({ open, onOpenChange, autoSharedWith }: ChiaumingImportDialogProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: trips = [] } = useTrips();
  const importTrip = useImportChiaumingTrip();
  const [text, setText] = useState('');
  const [choice, setChoice] = useState('');

  useEffect(() => {
    if (open) { setText(''); setChoice(''); }
  }, [open]);

  // 只有旅程擁有者能寫入行程表（Firestore Rules 的 canWriteTrip），被分享的旅程不能當更新目標。
  const ownTrips = useMemo(
    () => trips.filter((trip) => trip.userId === user?.uid || trip.ownerId === user?.uid),
    [trips, user?.uid],
  );

  const parsed = useMemo((): { plan: ChiaumingImportPlan | null; error: string } => {
    if (!text.trim()) return { plan: null, error: '' };
    try {
      return { plan: planChiaumingImport(parseChiaumingTrip(text.trim())), error: '' };
    } catch (err) {
      return { plan: null, error: err instanceof Error ? err.message : '無法解析匯入內容' };
    }
  }, [text]);
  const plan = parsed.plan;

  // 預設目標：先前匯入過就更新同一趟，否則名稱唯一相同的那趟，都沒有就建立新旅程。
  const defaultChoice = useMemo(() => {
    if (!plan) return '';
    const remembered = rememberedTripForSource(plan.sourceTripKey);
    if (remembered && ownTrips.some((trip) => trip.id === remembered)) return remembered;
    return matchTripByName(plan.name, ownTrips)?.id ?? NEW_TRIP;
  }, [plan, ownTrips]);
  const target = choice || defaultChoice;
  const targetTrip = target && target !== NEW_TRIP ? ownTrips.find((trip) => trip.id === target) : undefined;

  async function pasteFromClipboard(): Promise<void> {
    try {
      setText(await navigator.clipboard.readText());
      setChoice('');
    } catch (err) {
      console.error('[chiaumingImport.paste]', err);
      toast.error('瀏覽器不允許讀取剪貼簿，請直接貼到下方欄位');
    }
  }

  async function submit(): Promise<void> {
    if (!plan || !target) return;
    try {
      const result = await importTrip.mutateAsync({
        plan,
        target: targetTrip
          ? { kind: 'existing', trip: targetTrip }
          : {
            kind: 'new',
            status: statusForDates(plan.startDate, plan.endDate, formatTWDateInput(new Date())),
            sharedWith: autoSharedWith,
          },
      });
      const parts = [
        result.created > 0 ? `新增 ${result.created} 個` : '',
        result.updated > 0 ? `更新 ${result.updated} 個` : '',
        result.removed > 0 ? `移除 ${result.removed} 個` : '',
      ].filter(Boolean);
      toast.success(parts.length > 0 ? `已匯入行程：${parts.join('、')}項目` : '已匯入旅程');
      onOpenChange(false);
      navigate(`/trips/${result.tripId}`);
    } catch (err) {
      console.error('[chiaumingImport.submit]', err);
      toast.error(err instanceof Error ? err.message : '匯入失敗');
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="從巧明日常匯入行程"
      description="在巧明日常旅程的「行程」分頁按「複製到 RMoney」，再貼到這裡。"
      footer={(
        <Button className="w-full sm:w-auto" onClick={() => void submit()} disabled={!plan || !target || importTrip.isPending}>
          {importTrip.isPending ? <Loader2 className="size-4 animate-spin" /> : <ClipboardPaste className="size-4" />}
          {plan ? `${targetTrip ? '更新' : '建立'}旅程・${plan.stopCount} 個停留點` : '匯入'}
        </Button>
      )}
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Button variant="outline" size="sm" onClick={() => void pasteFromClipboard()}>
            <ClipboardPaste className="size-4" />從剪貼簿貼上
          </Button>
          <Textarea
            value={text}
            onChange={(event) => { setText(event.target.value); setChoice(''); }}
            placeholder='{"format":"chiauming-trip", …}'
            rows={plan ? 2 : 5}
            className="font-mono text-xs"
            aria-label="巧明日常行程資料"
            aria-invalid={Boolean(parsed.error)}
          />
          {parsed.error ? <p className="text-sm text-destructive" role="alert">{parsed.error}</p> : null}
        </div>

        {plan ? (
          <>
            <div className="rounded-lg border p-3 text-sm">
              <div className="text-base font-semibold">{plan.name}</div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                <span className="inline-flex items-center gap-1"><CalendarDays className="size-3.5" />{plan.startDate.replace(/-/g, '/')} ~ {shortDate(plan.endDate)}</span>
                {plan.destination.length > 0 ? <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" />{plan.destination.join(' · ')}</span> : null}
                <span>{plan.days.length} 天有安排・{plan.stopCount} 個停留點</span>
              </div>
            </div>

            <label className="grid gap-1.5 text-sm">
              <span className="text-muted-foreground">匯入到</span>
              <Select value={target || undefined} onValueChange={setChoice}>
                <SelectTrigger aria-label="匯入到"><SelectValue placeholder="選擇旅程" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NEW_TRIP}>建立新旅程「{plan.name}」</SelectItem>
                  {ownTrips.map((trip) => (
                    <SelectItem key={trip.id} value={trip.id}>
                      更新：{trip.name}（{formatTWDateInput(trip.startDate).slice(5).replace('-', '/')}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                {targetTrip
                  ? '只更新從巧明日常匯入過的項目；你在 RMoney 自己加的項目、花費與預算都不會動。日期只會往外擴。'
                  : '之後巧明日常改了行程，再複製一次匯入同一趟即可更新，不會重複。'}
              </span>
            </label>

            {plan.days.length > 0 ? (
              <div className="max-h-64 space-y-3 overflow-y-auto rounded-lg border p-3">
                {plan.days.map((day) => (
                  <div key={day.date} className="space-y-1">
                    <div className="text-xs font-semibold text-muted-foreground">{day.date.replace(/-/g, '/')}</div>
                    <ul className="space-y-1">
                      {day.items.map((item) => (
                        <li key={item.sourceId} className="flex gap-2 text-sm">
                          <span className="w-11 shrink-0 tabular-nums text-muted-foreground">{item.startTime ?? '—'}</span>
                          <span className="min-w-0">
                            <span className="font-medium">{item.title}</span>
                            {item.placeName && item.placeName !== item.title ? <span className="text-muted-foreground"> · {item.placeName}</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </ResponsiveDialog>
  );
}
