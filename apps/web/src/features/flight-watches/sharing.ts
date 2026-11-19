import type { FlightWatch } from './types';

/** 純函式：哪些「我建立的」訂閱的分享名單跟目前共同帳本成員不一致 */
export function flightSharingDrift(watches: FlightWatch[], myUid: string, targets: string[]): { id: string; sharedWith: string[] }[] {
  const want = [...targets].sort().join(',');
  return watches
    .filter((watch) => watch.userId === myUid && [...watch.sharedWith].sort().join(',') !== want)
    .map((watch) => ({ id: watch.id, sharedWith: [...targets].sort() }));
}
