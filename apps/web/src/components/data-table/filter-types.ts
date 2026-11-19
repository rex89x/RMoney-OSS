import { dateInputToTWBoundary } from '@/lib/tz';

export type FilterValue = string | string[] | { start?: string; end?: string } | undefined;

export interface SelectOption {
  value: string;
  label: string;
}

interface BaseFilter {
  id: string;
  label: string;
}

export interface SelectFilter extends BaseFilter {
  kind: 'select';
  options: SelectOption[];
  includeAll?: boolean; // 提供 "全部" 預設選項
}

export interface MultiSelectFilter extends BaseFilter {
  kind: 'multiSelect';
  options: SelectOption[];
}

export interface DateRangeFilter extends BaseFilter {
  kind: 'dateRange';
}

export interface TextFilter extends BaseFilter {
  kind: 'text';
  placeholder?: string;
}

export type FilterDef = SelectFilter | MultiSelectFilter | DateRangeFilter | TextFilter;

/**
 * 單筆資料比對 filter — 回 true 表示通過。
 */
export function rowMatchesFilters<T>(
  row: T,
  filters: FilterDef[],
  values: Record<string, FilterValue>,
  accessor: (row: T, id: string) => unknown,
): boolean {
  for (const f of filters) {
    const v = values[f.id];
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    const raw = accessor(row, f.id);
    if (f.kind === 'select') {
      // accessor 回陣列 = 這列同時屬於多個值（例：一筆支出同時是「共同」與「出遊」），任一符合即通過
      if (Array.isArray(raw)) { if (!raw.map(String).includes(String(v))) return false; }
      else if (String(raw ?? '') !== v) return false;
    } else if (f.kind === 'multiSelect') {
      if (!Array.isArray(v)) return false;
      // accessor 回陣列（例：交易的 tags）= 任一值有選到就通過
      if (Array.isArray(raw)) { if (!raw.map(String).some((x) => v.includes(x))) return false; }
      else if (!v.includes(String(raw ?? ''))) return false;
    } else if (f.kind === 'text') {
      const q = String(v).toLowerCase();
      if (!String(raw ?? '').toLowerCase().includes(q)) return false;
    } else if (f.kind === 'dateRange') {
      const range = v as { start?: string; end?: string };
      const d = raw instanceof Date ? raw : raw ? new Date(raw as string | number) : null;
      if (!d) return false;
      if (range.start) {
        const s = dateInputToTWBoundary(range.start, 'start');
        if (!s) return false;
        if (d < s) return false;
      }
      if (range.end) {
        const e = dateInputToTWBoundary(range.end, 'end');
        if (!e) return false;
        if (d > e) return false;
      }
    }
  }
  return true;
}
