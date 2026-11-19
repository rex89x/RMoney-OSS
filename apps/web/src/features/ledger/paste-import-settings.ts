import type { ImportMode, SourcePerson } from './paste-import-plan';

/**
 * 「貼上匯入」記住的便利設定（localStorage）。出遊的「從巧明日常匯入」也會寫入
 * `tripBySource`，之後貼上同一趟旅程的費用就會預選匯入時建立／更新的那趟 RMoney 旅程。
 */
const SETTINGS_KEY = 'rmoney:paste-import:v1';

/** 只記「上次的選擇」這種便利設定；讀寫失敗就當沒有。 */
export interface SavedSettings {
  accountId?: string;
  mode?: ImportMode;
  categoryMap?: Record<string, string>;
  /** 巧明日常旅程 key → RMoney trip id，或 NO_TRIP。 */
  tripBySource?: Record<string, string>;
  counterpartyName?: string;
  memberMapByTrip?: Record<string, Record<SourcePerson, string>>;
}

export function loadSettings(): SavedSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as SavedSettings) : {};
  } catch {
    return {};
  }
}

export function saveSettings(next: SavedSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // 私密模式或被封鎖時只是下次不會記得，不影響匯入。
  }
}

/** 記住巧明日常旅程 key 對應到哪一趟 RMoney 旅程。 */
export function rememberTripForSource(sourceTripKey: string, tripId: string): void {
  const prev = loadSettings();
  saveSettings({ ...prev, tripBySource: { ...prev.tripBySource, [sourceTripKey]: tripId } });
}

/** 先前記住的 RMoney 旅程 id；沒有或選了「不歸屬」時回傳 undefined。 */
export function rememberedTripForSource(sourceTripKey: string): string | undefined {
  return loadSettings().tripBySource?.[sourceTripKey];
}
