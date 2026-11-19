import { useEffect, useState } from 'react';
import { MapPin, Utensils, Ticket, Hotel, ShoppingBag, Car, Link2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { TimePicker } from '@/components/ui/time-picker';
import { cn } from '@/lib/utils';
import { callAppsScript } from '@/lib/apps-script';
import {
  buildMapsUrlFromCoords, isMapsUrl, isShortMapsUrl, parseGoogleMapsUrl,
} from '@/lib/google-maps-url';
import type { ItineraryItem, ItineraryItemType } from '../types';
import { PlacePreview } from './place-preview';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 存在表示編輯既有 item；否則新增 */
  item?: ItineraryItem | null;
  onSave: (item: Omit<ItineraryItem, 'id'> & { id?: string }) => void | Promise<void>;
  defaultStartTime?: string;
}

const TYPE_OPTIONS: { value: ItineraryItemType; label: string; icon: typeof Utensils }[] = [
  { value: 'transport', label: '交通', icon: Car },
  { value: 'meal', label: '餐食', icon: Utensils },
  { value: 'activity', label: '景點', icon: Ticket },
  { value: 'accommodation', label: '住宿', icon: Hotel },
  { value: 'shopping', label: '購物', icon: ShoppingBag },
];

interface PlaceState {
  placeName?: string;
  address?: string;
  lat?: number;
  lng?: number;
  photoUrl?: string;
  mapsUrl?: string;
  placeId?: string;
}

interface ResolveResult {
  ok: boolean;
  error?: string;
  result?: {
    lat: number;
    lng: number;
    name?: string | null;
    address?: string | null;
    placeId?: string | null;
    photoUrl?: string | null;
    mapsUrl?: string | null;
  };
}

export function ItineraryItemDialog({
  open, onOpenChange, item, onSave, defaultStartTime,
}: Props) {
  const [title, setTitle] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [type, setType] = useState<ItineraryItemType>('activity');
  const [placeName, setPlaceName] = useState('');
  const [mapsUrlInput, setMapsUrlInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [place, setPlace] = useState<PlaceState>({});
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open) return;
    if (item) {
      setTitle(item.title);
      setStartTime(item.startTime ?? '');
      setEndTime(item.endTime ?? '');
      setType(item.type ?? 'activity');
      setPlaceName(item.placeName ?? '');
      setMapsUrlInput(item.mapsUrl ?? '');
      setPlace({
        placeName: item.placeName,
        address: item.address,
        lat: item.lat,
        lng: item.lng,
        photoUrl: item.photoUrl,
        mapsUrl: item.mapsUrl,
        placeId: item.placeId,
      });
      setCost(item.estimatedCost != null ? String(item.estimatedCost) : '');
      setNotes(item.notes ?? '');
    } else {
      setTitle('');
      setStartTime(defaultStartTime ?? '');
      setEndTime('');
      setType('activity');
      setPlaceName('');
      setMapsUrlInput('');
      setPlace({});
      setCost('');
      setNotes('');
    }
  }, [open, item, defaultStartTime]);

  async function handleResolveUrl() {
    const url = mapsUrlInput.trim();
    if (!url) return;
    if (!isMapsUrl(url)) {
      toast.error('看起來不是 Google 地圖連結');
      return;
    }
    setResolving(true);
    try {
      // 1. 短網址直接走後端展開
      // 2. 長網址先試本地 parser，拿不到再 fallback 後端
      let lat: number | undefined;
      let lng: number | undefined;
      let name: string | undefined;
      let address: string | undefined;
      let photoUrl: string | undefined;
      let placeId: string | undefined;
      let resolvedUrl = url;

      if (!isShortMapsUrl(url)) {
        const parsed = parseGoogleMapsUrl(url);
        if (parsed) {
          lat = parsed.lat;
          lng = parsed.lng;
          name = parsed.name;
          resolvedUrl = parsed.mapsUrl;
        }
      }

      if (lat == null || lng == null) {
        const resp = (await callAppsScript('resolveGoogleMapsUrl', undefined, { url })) as ResolveResult;
        if (!resp.ok || !resp.result) {
          throw new Error(resp.error || '無法解析此連結');
        }
        const r = resp.result;
        lat = r.lat;
        lng = r.lng;
        name = r.name ?? undefined;
        address = r.address ?? undefined;
        photoUrl = r.photoUrl ?? undefined;
        placeId = r.placeId ?? undefined;
        resolvedUrl = r.mapsUrl ?? url;
      }

      const next: PlaceState = {
        placeName: name || place.placeName,
        address: address || place.address,
        lat,
        lng,
        photoUrl: photoUrl || place.photoUrl,
        mapsUrl: resolvedUrl,
        placeId: placeId || place.placeId,
      };
      setPlace(next);
      if (!placeName && next.placeName) setPlaceName(next.placeName);
      if (!title && next.placeName) setTitle(next.placeName);
      toast.success('已解析地點');
    } catch (err) {
      console.error('[resolveGoogleMapsUrl]', err);
      toast.error(err instanceof Error ? err.message : '解析失敗');
    } finally {
      setResolving(false);
    }
  }

  function clearPlace() {
    setPlace({});
    setMapsUrlInput('');
  }

  async function handleSubmit() {
    if (!title.trim()) return;
    const finalMapsUrl = place.mapsUrl
      ?? (place.lat != null && place.lng != null
        ? buildMapsUrlFromCoords(place.lat, place.lng, place.placeName ?? title.trim())
        : undefined);
    try {
      await onSave({
        id: item?.id,
        order: item?.order ?? 0,
        title: title.trim(),
        startTime: startTime || undefined,
        endTime: endTime || undefined,
        type,
        placeName: placeName || place.placeName || undefined,
        address: place.address,
        lat: place.lat,
        lng: place.lng,
        placeId: place.placeId,
        photoUrl: place.photoUrl,
        mapsUrl: finalMapsUrl,
        estimatedCost: cost ? parseFloat(cost) : undefined,
        currency: 'TWD',
        notes: notes || undefined,
        status: item?.status ?? 'planned',
      });
      onOpenChange(false);
    } catch (err) {
      console.error('[itineraryItemSave]', err);
      toast.error(err instanceof Error ? err.message : '行程項目儲存失敗');
    }
  }

  const hasCoords = place.lat != null && place.lng != null;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? '編輯項目' : '新增項目'}
      description="填寫時段、類型與備註；可貼 Google 地圖分享連結自動帶座標。"
      contentClassName="sm:max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => void handleSubmit()} disabled={!title.trim()}>
            儲存
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>名稱</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：金閣寺、ラーメン一蘭"
            autoFocus
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>開始時間</Label>
            <TimePicker value={startTime} onChange={setStartTime} size="sm" />
          </div>
          <div>
            <Label>結束時間（選填）</Label>
            <TimePicker value={endTime} onChange={setEndTime} size="sm" />
          </div>
        </div>

        <div>
          <Label className="mb-1 block">類型</Label>
          <div className="grid grid-cols-5 gap-1.5">
            {TYPE_OPTIONS.map((t) => {
              const on = type === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setType(t.value)}
                  className={cn(
                    'flex flex-col items-center justify-center gap-0.5 rounded-md border p-2 text-xs transition-colors',
                    on ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
                  )}
                >
                  <t.icon className="size-4" />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <div className="flex items-center gap-1 text-sm font-medium">
            <MapPin className="size-3.5" /> 地點
          </div>
          <div>
            <Label className="text-xs">地點名稱</Label>
            <Input
              value={placeName}
              onChange={(e) => setPlaceName(e.target.value)}
              placeholder="例如：金閣寺"
            />
          </div>
          <div>
            <Label className="text-xs flex items-center gap-1">
              <Link2 className="size-3" /> Google 地圖連結（選填，可貼分享網址）
            </Label>
            <div className="flex gap-2">
              <Input
                value={mapsUrlInput}
                onChange={(e) => setMapsUrlInput(e.target.value)}
                placeholder="https://maps.app.goo.gl/..."
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleResolveUrl();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleResolveUrl()}
                disabled={resolving || !mapsUrlInput.trim()}
              >
                {resolving ? <Loader2 className="size-4 animate-spin" /> : '解析'}
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              支援 Google 地圖長網址、短網址（maps.app.goo.gl / goo.gl/maps）。
            </p>
          </div>

          {hasCoords ? (
            <div className="space-y-2">
              <PlacePreview
                lat={place.lat as number}
                lng={place.lng as number}
                name={place.placeName}
                address={place.address}
                photoUrl={place.photoUrl}
                mapsUrl={place.mapsUrl}
                height={140}
              />
              <Button type="button" variant="ghost" size="sm" onClick={clearPlace}>
                清除地點
              </Button>
            </div>
          ) : null}
        </div>

        <div>
          <Label>預估花費 (TWD)</Label>
          <Input
            type="number"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="0"
          />
        </div>

        <div>
          <Label>備註</Label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="任何想記下的事"
          />
        </div>
      </div>
    </ResponsiveDialog>
  );
}
