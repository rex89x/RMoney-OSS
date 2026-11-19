import { ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { DataTable } from './use-data-table';

interface Props<T> {
  table: DataTable<T>;
  pageSizes?: number[];
  className?: string;
  /** 把「N 筆」顯示在左邊（預設顯示） */
  showTotal?: boolean;
}

export function DataTablePagination<T>({
  table,
  pageSizes = [10, 25, 50, 100],
  className,
  showTotal = true,
}: Props<T>) {
  const { page, pageCount, pageSize, totalFiltered, total, setPage, setPageSize } = table;
  const start = totalFiltered === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalFiltered);

  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-2 text-xs', className)}>
      <div className="text-muted-foreground">
        {showTotal && (
          totalFiltered === total
            ? <>共 {total} 筆</>
            : <>{totalFiltered} / {total} 筆</>
        )}
        {totalFiltered > 0 && <> · 顯示 {start}–{end}</>}
      </div>
      <div className="flex items-center gap-2">
        <Select value={String(pageSize)} onValueChange={(v) => setPageSize(parseInt(v, 10))}>
          <SelectTrigger className="h-9 w-[72px] text-xs md:h-8" aria-label="每頁筆數"><SelectValue /></SelectTrigger>
          <SelectContent>
            {pageSizes.map((s) => <SelectItem key={s} value={String(s)}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" disabled={page === 1} onClick={() => setPage(1)} aria-label="第一頁">
            <ChevronsLeft className="size-4" />
          </Button>
          <Button variant="outline" size="icon-sm" disabled={page === 1} onClick={() => setPage(page - 1)} aria-label="上一頁">
            <ChevronLeft className="size-4" />
          </Button>
          <span className="tabular-nums px-1">{page} / {pageCount}</span>
          <Button variant="outline" size="icon-sm" disabled={page >= pageCount} onClick={() => setPage(page + 1)} aria-label="下一頁">
            <ChevronRight className="size-4" />
          </Button>
          <Button variant="outline" size="icon-sm" disabled={page >= pageCount} onClick={() => setPage(pageCount)} aria-label="最後一頁">
            <ChevronsRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
