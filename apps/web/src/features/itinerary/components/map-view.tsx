import { useEffect, useMemo, useRef, useState } from 'react';
import { env } from '@/lib/env';
import type { ItineraryItem } from '../types';

interface LatLng {
  lat: number;
  lng: number;
}

interface GMap {
  setCenter(p: LatLng): void;
  fitBounds(b: GBounds): void;
}

interface GBounds {
  extend(p: LatLng): void;
}

interface GMapCtor {
  new (el: Element, opts?: Record<string, unknown>): GMap;
}

interface GBoundsCtor {
  new (): GBounds;
}

interface GMarkerCtor {
  new (opts: {
    position: LatLng;
    map: GMap;
    title?: string;
    label?: string | { text: string; color?: string; fontWeight?: string };
    icon?: unknown;
  }): unknown;
}

interface GPolylineCtor {
  new (opts: {
    path: LatLng[];
    map: GMap;
    geodesic?: boolean;
    strokeColor?: string;
    strokeOpacity?: number;
    strokeWeight?: number;
    icons?: unknown[];
  }): unknown;
}

interface GMapsLib {
  Map: GMapCtor;
  LatLngBounds: GBoundsCtor;
  Marker: GMarkerCtor;
  Polyline: GPolylineCtor;
}

type WindowWithGoogle = Window & { google?: { maps: GMapsLib } };

// Load Google Maps JS API once per page
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

export interface MapPoint {
  lat: number;
  lng: number;
  title?: string;
  /** 用於分組顏色（trip overview 用 dayId / dayIndex） */
  groupKey?: string;
  /** 顯示在 marker label 上的編號 */
  label?: string;
  color?: string;
}

export function MapView({ items, height = 420 }: { items: ItineraryItem[]; height?: number }) {
  const points = useMemo<MapPoint[]>(
    () =>
      items
        .filter((it) => typeof it.lat === 'number' && typeof it.lng === 'number')
        .map((it, i) => ({
          lat: it.lat as number,
          lng: it.lng as number,
          title: it.title,
          label: String(i + 1),
        })),
    [items],
  );

  return (
    <PointsMap
      points={points}
      height={height}
      connect
      emptyHint="行程項目尚未含座標 — 解析 Google 地圖連結或讓 LLM 生成會自動帶座標"
    />
  );
}

export function PointsMap({
  points, height = 420, emptyHint = '尚無座標', connect = false,
}: {
  points: MapPoint[];
  height?: number;
  emptyHint?: string;
  /** 依順序用直線把點連起來（示意順序，不是實際路線；不呼叫 Directions API） */
  connect?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!ref.current) return;
    if (points.length === 0) return;
    loadMaps()
      .then((maps) => {
        if (cancelled || !ref.current) return;
        const first = points[0]!; // 非空：索引已做邊界 / 長度檢查
        const map = new maps.Map(ref.current, {
          center: { lat: first.lat, lng: first.lng },
          zoom: 12,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        });
        const bounds = new maps.LatLngBounds();
        points.forEach((p) => {
          bounds.extend({ lat: p.lat, lng: p.lng });
          new maps.Marker({
            position: { lat: p.lat, lng: p.lng },
            map,
            title: p.title,
            label: p.label
              ? p.color
                ? { text: p.label, color: '#fff', fontWeight: '600' }
                : p.label
              : undefined,
            icon: p.color
              ? {
                  path:
                    'M12 0C7.03 0 3 4.03 3 9c0 6.75 9 15 9 15s9-8.25 9-15c0-4.97-4.03-9-9-9z',
                  fillColor: p.color,
                  fillOpacity: 1,
                  strokeColor: '#ffffff',
                  strokeWeight: 1.5,
                  scale: 1.3,
                  labelOrigin: { x: 12, y: 9 },
                  anchor: { x: 12, y: 22 },
                }
              : undefined,
          });
        });
        if (connect && points.length >= 2) {
          new maps.Polyline({
            path: points.map((p) => ({ lat: p.lat, lng: p.lng })),
            map,
            geodesic: true,
            strokeColor: '#6366f1',
            strokeOpacity: 0,
            strokeWeight: 3,
            // 虛線：提醒這只是順序示意，實際路線請按「路線」開 Google 地圖
            icons: [{
              icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.8, scale: 3 },
              offset: '0',
              repeat: '14px',
            }],
          });
        }
        map.fitBounds(bounds);
      })
      .catch((err: unknown) => {
        console.error('[maps]', err);
        setError(err instanceof Error ? err.message : 'maps failed');
      });
    return () => {
      cancelled = true;
    };
  }, [points, connect]);

  if (error) {
    return (
      <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        {error}
      </div>
    );
  }
  if (points.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        {emptyHint}
      </div>
    );
  }
  return <div ref={ref} style={{ height }} className="w-full overflow-hidden rounded-xl border" />;
}
