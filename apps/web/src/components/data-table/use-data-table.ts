import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { FilterDef, FilterValue } from './filter-types';
import { rowMatchesFilters } from './filter-types';

export interface UseDataTableOptions<T> {
  data: T[];
  /** 把欄位值拉出來給 search / filter 用。回傳 string → search 比對用；回傳其他值 → filter 比對用。 */
  accessor: (row: T, id: string) => unknown;
  /** 全域搜尋 targets：每個 row 要比對的文字欄位。accessor 回傳會被 String() 後做 includes 比對。 */
  searchFields?: string[];
  filters?: FilterDef[];
  /** 每頁筆數（可切）。預設 25。 */
  pageSize?: number;
  /** URL query 前綴，讓多個 table 同頁不打架。預設無前綴。 */
  urlKey?: string;
  /** 預設 filter 值 */
  defaultFilters?: Record<string, FilterValue>;
  /** 不要把 state 同步到 URL（單頁內彈窗用） */
  disableUrlState?: boolean;
}

export interface DataTable<T> {
  rows: T[];              // 當前頁資料（已套 search/filter/分頁）
  totalFiltered: number;  // 套完 search + filter 的總數
  filteredRows: T[];      // 套完 search + filter、還沒分頁的全部列（算區間合計用）
  total: number;          // 原始資料總數
  page: number;
  pageSize: number;
  pageCount: number;
  setPage: (p: number) => void;
  setPageSize: (s: number) => void;
  search: string;
  setSearch: (s: string) => void;
  filterValues: Record<string, FilterValue>;
  setFilterValue: (id: string, v: FilterValue) => void;
  clearFilters: () => void;
  filters: FilterDef[];
}

/**
 * 純 client-side table — 適用已透過 Firestore `limit()` 拉回一批後，在前端做搜尋/篩選/分頁。
 */
export function useDataTable<T>(opts: UseDataTableOptions<T>): DataTable<T> {
  const {
    data,
    accessor,
    searchFields = [],
    filters = [],
    pageSize: initPageSize = 25,
    urlKey,
    defaultFilters = {},
    disableUrlState = false,
  } = opts;

  const [params, setParams] = useSearchParams();
  const prefix = urlKey ? `${urlKey}_` : '';

  const urlGet = (k: string) => (disableUrlState ? null : params.get(prefix + k));
  const urlGetAll = (k: string) => (disableUrlState ? [] : params.getAll(prefix + k));

  const [search, setSearchInternal] = useState<string>(() => urlGet('q') ?? '');
  const [debouncedSearch, setDebouncedSearch] = useState(search);

  const [page, setPageInternal] = useState<number>(() => {
    const p = parseInt(urlGet('page') ?? '1', 10);
    return Number.isFinite(p) && p > 0 ? p : 1;
  });

  const [pageSize, setPageSizeInternal] = useState<number>(() => {
    const s = parseInt(urlGet('size') ?? String(initPageSize), 10);
    return Number.isFinite(s) && s > 0 ? s : initPageSize;
  });

  const initialFilterValues = useMemo(() => {
    const v: Record<string, FilterValue> = { ...defaultFilters };
    for (const f of filters) {
      if (f.kind === 'multiSelect') {
        const got = urlGetAll(f.id);
        if (got.length) v[f.id] = got;
      } else if (f.kind === 'dateRange') {
        const start = urlGet(`${f.id}_start`);
        const end = urlGet(`${f.id}_end`);
        if (start || end) v[f.id] = { start: start ?? undefined, end: end ?? undefined };
      } else {
        const got = urlGet(f.id);
        if (got !== null && got !== '') v[f.id] = got;
      }
    }
    return v;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [filterValues, setFilterValues] = useState<Record<string, FilterValue>>(initialFilterValues);

  // debounce search 300ms
  useEffect(() => {
    const h = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(h);
  }, [search]);

  // sync state → URL
  const skipFirst = useRef(true);
  useEffect(() => {
    if (disableUrlState) return;
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      // 清掉舊 table 相關 key
      Array.from(next.keys()).forEach((k) => {
        if (urlKey ? k.startsWith(prefix) : isOurKey(k, filters)) next.delete(k);
      });
      // search
      if (debouncedSearch) next.set(prefix + 'q', debouncedSearch);
      // page / size
      if (page > 1) next.set(prefix + 'page', String(page));
      if (pageSize !== initPageSize) next.set(prefix + 'size', String(pageSize));
      // filters
      for (const f of filters) {
        const v = filterValues[f.id];
        if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
        if (f.kind === 'multiSelect') {
          (v as string[]).forEach((x) => next.append(prefix + f.id, x));
        } else if (f.kind === 'dateRange') {
          const r = v as { start?: string; end?: string };
          if (r.start) next.set(prefix + f.id + '_start', r.start);
          if (r.end) next.set(prefix + f.id + '_end', r.end);
        } else {
          next.set(prefix + f.id, String(v));
        }
      }
      return next;
    }, { replace: true });
  }, [debouncedSearch, page, pageSize, filterValues, disableUrlState, filters, setParams, prefix, urlKey, initPageSize]);

  const setFilterValue = useCallback((id: string, v: FilterValue) => {
    setFilterValues((prev) => ({ ...prev, [id]: v }));
    setPageInternal(1);
  }, []);

  const clearFilters = useCallback(() => {
    setFilterValues({});
    setSearchInternal('');
    setPageInternal(1);
  }, []);

  const setSearch = useCallback((s: string) => {
    setSearchInternal(s);
    setPageInternal(1);
  }, []);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return data.filter((row) => {
      if (q && searchFields.length > 0) {
        const hit = searchFields.some((f) => {
          const v = accessor(row, f);
          return String(v ?? '').toLowerCase().includes(q);
        });
        if (!hit) return false;
      }
      return rowMatchesFilters(row, filters, filterValues, accessor);
    });
  }, [data, debouncedSearch, searchFields, filters, filterValues, accessor]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const rows = useMemo(
    () => filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filtered, safePage, pageSize],
  );

  return {
    rows,
    filteredRows: filtered,
    totalFiltered: filtered.length,
    total: data.length,
    page: safePage,
    pageSize,
    pageCount,
    setPage: setPageInternal,
    setPageSize: (s) => { setPageSizeInternal(s); setPageInternal(1); },
    search,
    setSearch,
    filterValues,
    setFilterValue,
    clearFilters,
    filters,
  };
}

function isOurKey(key: string, filters: FilterDef[]): boolean {
  if (key === 'q' || key === 'page' || key === 'size') return true;
  return filters.some((f) => f.id === key || key === `${f.id}_start` || key === `${f.id}_end`);
}
