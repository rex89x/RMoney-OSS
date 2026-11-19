import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { listRecentErrors } from '@/lib/error-log';
import { formatTW } from '@/lib/tz';

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];

export function ErrorLogsPanel() {
  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['error-logs', 'recent-3d'],
    queryFn: () => listRecentErrors(3, 500),
    staleTime: 30 * 1000,
  });

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<PageSize>(20);

  const totalPages = Math.max(1, Math.ceil(logs.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = useMemo(
    () => logs.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [logs, safePage, pageSize],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="size-4" /> 錯誤紀錄
          <span className="text-xs font-normal text-muted-foreground">近 3 天 · 共 {logs.length} 筆</span>
        </CardTitle>
        <select
          value={pageSize}
          onChange={(e) => { setPageSize(Number(e.target.value) as PageSize); setPage(0); }}
          className="h-8 rounded-md border bg-background px-2 text-xs"
          aria-label="每頁筆數"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>{n} / 頁</option>
          ))}
        </select>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中…</p>
        ) : logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">近 3 天無錯誤紀錄</p>
        ) : (
          <>
            <ul className="divide-y rounded-md border">
              {pageRows.map((l) => (
                <li key={l.id} className="space-y-1 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{l.message || '(no message)'}</span>
                    <Badge variant="outline" className="shrink-0">{l.scope}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">{formatTW(l.createdAt, 'yyyy-MM-dd HH:mm:ss')}</div>
                  {l.url && <div className="truncate text-[11px] text-muted-foreground">{l.url}</div>}
                  {l.stack && (
                    <details className="text-[11px]">
                      <summary className="cursor-pointer text-muted-foreground">stack</summary>
                      <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-muted p-2 text-[10px]">{l.stack}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <div>
                第 {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, logs.length)} 筆 / 共 {logs.length}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPage(Math.max(0, safePage - 1))}
                  disabled={safePage === 0}
                  aria-label="prev"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span>{safePage + 1} / {totalPages}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
                  disabled={safePage >= totalPages - 1}
                  aria-label="next"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
