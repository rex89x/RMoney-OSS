import { Check, Search, X, CheckSquare, Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { DateRangePicker } from '@/components/ui/date-picker';
import { useIsDesktop } from '@/hooks/use-media-query';
import { cn } from '@/lib/utils';
import { formatDateInput, parseDateInput } from '@/lib/tz';
import type { DataTable } from './use-data-table';

interface ToolbarProps<T> {
  table: DataTable<T>;
  searchPlaceholder?: string;
  hideSearch?: boolean;
  className?: string;
  rightExtra?: React.ReactNode;
}

export function DataTableToolbar<T>({
  table,
  searchPlaceholder = '搜尋…',
  hideSearch,
  className,
  rightExtra,
}: ToolbarProps<T>) {
  const activeCount = countActiveFilters(table);
  const isDesktop = useIsDesktop();
  const hasFilters = table.filters.length > 0;

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {!hideSearch && (
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={table.search}
            onChange={(e) => table.setSearch(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-9 pl-9 pr-8"
          />
          {table.search && (
            <button
              type="button"
              onClick={() => table.setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted"
              aria-label="清除"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Desktop: 平鋪 filter chips；Mobile: 收進 popover 避免擠成多行 */}
      {isDesktop && hasFilters && table.filters.map((f) => (
        <FilterControl key={f.id} table={table} filterId={f.id} />
      ))}

      {!isDesktop && hasFilters && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-9">
              <Filter className="size-4" />
              篩選
              {activeCount > 0 && <Badge variant="secondary">{activeCount}</Badge>}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 space-y-2 p-3" align="end">
            <div className="text-xs font-medium text-muted-foreground">篩選條件</div>
            {table.filters.map((f) => (
              <div key={f.id}>
                <div className="mb-1 text-[11px] text-muted-foreground">{f.label}</div>
                <FilterControl table={table} filterId={f.id} />
              </div>
            ))}
          </PopoverContent>
        </Popover>
      )}

      {activeCount > 0 && (
        <Button variant="ghost" size="sm" onClick={table.clearFilters}>
          <X className="size-4" /> 清除 <Badge variant="secondary" className="ml-1">{activeCount}</Badge>
        </Button>
      )}

      {rightExtra}
    </div>
  );
}

function countActiveFilters<T>(table: DataTable<T>): number {
  let n = table.search ? 1 : 0;
  for (const [, v] of Object.entries(table.filterValues)) {
    if (v === undefined || v === '') continue;
    if (Array.isArray(v)) { if (v.length > 0) n++; continue; }
    if (typeof v === 'object' && v) {
      const r = v as { start?: string; end?: string };
      if (r.start || r.end) n++;
      continue;
    }
    n++;
  }
  return n;
}

function FilterControl<T>({ table, filterId }: { table: DataTable<T>; filterId: string }) {
  const f = table.filters.find((x) => x.id === filterId);
  if (!f) return null;
  const v = table.filterValues[filterId];

  if (f.kind === 'select') {
    const curr = typeof v === 'string' ? v : '';
    return (
      <Select
        value={curr || 'all'}
        onValueChange={(nv) => table.setFilterValue(filterId, nv === 'all' ? undefined : nv)}
      >
        <SelectTrigger className="h-9 w-auto min-w-[120px]">
          <SelectValue placeholder={f.label} />
        </SelectTrigger>
        <SelectContent>
          {f.includeAll !== false && <SelectItem value="all">{f.label}：全部</SelectItem>}
          {f.options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (f.kind === 'multiSelect') {
    const selected = Array.isArray(v) ? v : [];
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-9">
            <CheckSquare className="size-4" />
            {f.label}
            {selected.length > 0 && <Badge variant="secondary">{selected.length}</Badge>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-2" align="start">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium">{f.label}</span>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => table.setFilterValue(filterId, [])}
                className="text-muted-foreground hover:underline"
              >
                清除
              </button>
            )}
          </div>
          <ul className="max-h-64 space-y-0.5 overflow-y-auto">
            {f.options.map((o) => {
              const on = selected.includes(o.value);
              return (
                <li key={o.value}>
                  <button
                    type="button"
                    onClick={() => {
                      const next = on
                        ? selected.filter((x) => x !== o.value)
                        : [...selected, o.value];
                      table.setFilterValue(filterId, next);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors',
                      on ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
                    )}
                  >
                    <span className="truncate">{o.label}</span>
                    {on && <Check className="size-3.5" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    );
  }

  if (f.kind === 'dateRange') {
    const r = (v as { start?: string; end?: string } | undefined) || {};
    const toDate = (s?: string) => (s ? parseDateInput(s) ?? undefined : undefined);
    const fromDate = (d?: Date) => (d ? formatDateInput(d) : undefined);
    return (
      <DateRangePicker
        value={{ from: toDate(r.start), to: toDate(r.end) }}
        onChange={(range) => {
          if (!range) {
            table.setFilterValue(filterId, undefined);
            return;
          }
          table.setFilterValue(filterId, {
            start: fromDate(range.from),
            end: fromDate(range.to),
          });
        }}
        placeholder={f.label}
        className="h-9 w-auto min-w-[160px]"
        size="sm"
      />
    );
  }

  if (f.kind === 'text') {
    return (
      <Input
        value={typeof v === 'string' ? v : ''}
        onChange={(e) => table.setFilterValue(filterId, e.target.value)}
        placeholder={f.placeholder ?? f.label}
        className="h-9 w-40"
      />
    );
  }

  return null;
}
