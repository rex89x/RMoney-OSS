import { useEffect, useRef, useState } from 'react';
import { ExternalLink, MapPin } from 'lucide-react';
import { env } from '@/lib/env';
import { buildMapsUrlFromCoords } from '@/lib/google-maps-url';
import { cn } from '@/lib/utils';

interface LatLng { lat: number; lng: number }
interface GMap { setCenter(p: LatLng): void; setZoom(z: number): void }
interface GMarkerCtor { new (opts: { position: LatLng; map: GMap; title?: string }): unknown }
interface GMapCtor { new (el: Element, opts?: Record<string, unknown>): GMap }
interface GMapsLib { Map: GMapCtor; Marker: GMarkerCtor }

type WindowWithGoogle = Window & { google?: { maps: GMapsLib } };

let mapsPromise: Promise<GMapsLib> | null = null;

function loadMaps(): Promise<GMapsLib> {
  if (mapsPromise) return mapsPromise;
  if (typeof window !== 'undefined') {
    const existing = (window as WindowWithGoogle).google?.maps;
    if (existing) {
      mapsPromise = Promise.resolve(existing);
      return mapsPromise;
    }
  }
  const key = env.googleMapsApiKey;
  if (!key) return Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY 未設定'));
  mapsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const g = (window as WindowWithGoogle).google;
      if (!g?.maps) {
        reject(new Error('Google Maps loaded but window.google.maps missing'));
        return;
      }
      resolve(g.maps);
    };
    script.onerror = () => reject(new Error('Google Maps load failed'));
    document.head.appendChild(script);
  });
  return mapsPromise;
}

export interface PlacePreviewProps {
  lat: number;
  lng: number;
  name?: string;
  address?: string;
  photoUrl?: string;
  mapsUrl?: string;
  className?: string;
  height?: number;
  zoom?: number;
}

export function PlacePreview({
  lat, lng, name, address, photoUrl, mapsUrl,
  className, height = 160, zoom = 14,
}: PlacePreviewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!ref.current) return;
    if (!isFinite(lat) || !isFinite(lng)) {
      setError('座標不正確');
      return;
    }
    loadMaps()
      .then((maps) => {
        if (cancelled || !ref.current) return;
        const map = new maps.Map(ref.current, {
          center: { lat, lng },
          zoom,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          zoomControl: false,
          gestureHandling: 'cooperative',
        });
        new maps.Marker({ position: { lat, lng }, map, title: name });
      })
      .catch((err: unknown) => {
        console.error('[place-preview]', err);
        setError(err instanceof Error ? err.message : 'maps failed');
      });
    return () => { cancelled = true; };
  }, [lat, lng, name, zoom]);

  const finalMapsUrl = mapsUrl || buildMapsUrlFromCoords(lat, lng, name);

  return (
    <div className={cn('overflow-hidden rounded-lg border', className)}>
      {photoUrl ? (
        <div
          className="h-32 w-full bg-muted bg-cover bg-center"
          style={{ backgroundImage: `url(${JSON.stringify(photoUrl).slice(1, -1)})` }}
          aria-hidden
        />
      ) : null}
      {error ? (
        <div className="p-3 text-xs text-muted-foreground">{error}</div>
      ) : (
        <div ref={ref} style={{ height }} className="w-full bg-muted" />
      )}
      <div className="space-y-1 p-3 text-xs">
        {name ? <div className="text-sm font-medium">{name}</div> : null}
        {address ? (
          <div className="flex items-start gap-1 text-muted-foreground">
            <MapPin className="mt-0.5 size-3 shrink-0" />
            <span className="break-words">{address}</span>
          </div>
        ) : null}
        <a
          href={finalMapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          <ExternalLink className="size-3" /> 在 Google 地圖開啟
        </a>
      </div>
    </div>
  );
}
