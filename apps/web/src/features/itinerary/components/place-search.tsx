import { useEffect, useRef, useState } from 'react';
import { Search, MapPin, Loader2, Star } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { callAppsScript } from '@/lib/apps-script';
import { debounce } from '@/lib/utils';
import { toast } from 'sonner';

interface PlaceResult {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating?: number;
}

interface Props {
  onSelect: (place: PlaceResult) => void;
}

export function PlaceSearch({ onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debouncedRef = useRef(
    debounce(async (q: string) => {
      if (!q.trim()) {
        setResults([]);
        return;
      }
      setLoading(true);
      try {
        const resp = await callAppsScript<PlaceResult[]>('placesSearch', { q });
        setResults((resp as { results?: PlaceResult[] }).results ?? []);
      } catch (err) {
        console.error('[placesSearch]', err);
        toast.error(err instanceof Error ? err.message : '搜尋失敗');
      } finally {
        setLoading(false);
      }
    }, 400),
  );

  useEffect(() => {
    debouncedRef.current(query);
  }, [query]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋地點（景點、餐廳、飯店…）"
          className="h-11 pl-9"
        />
        {loading ? (
          <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      {results.length > 0 ? (
        <ul className="divide-y rounded-xl border bg-card">
          {results.map((r) => (
            <li key={r.placeId}>
              <Button
                variant="ghost"
                className="h-auto w-full justify-start gap-3 rounded-none px-3 py-2.5 text-left"
                onClick={() => {
                  onSelect(r);
                  setQuery('');
                  setResults([]);
                }}
              >
                <MapPin className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-sm font-medium">{r.name}</span>
                  <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                    <span className="truncate">{r.address}</span>
                    {typeof r.rating === 'number' ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5">
                        <Star className="size-3 fill-current text-amber-500" />
                        {r.rating.toFixed(1)}
                      </span>
                    ) : null}
                  </span>
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
