import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatTW } from '@/lib/tz';
import { useAuditLogs } from '../hooks';
import type { AuditAction } from '../types';

const ACTION_LABEL: Record<AuditAction, string> = {
  create: '建立',
  update: '更新',
  delete: '刪除',
  restore: '復原',
  archive: '封存',
  unarchive: '解封',
};

const ACTION_VARIANT: Record<AuditAction, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  create: 'default',
  update: 'secondary',
  delete: 'destructive',
  restore: 'outline',
  archive: 'outline',
  unarchive: 'outline',
};

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];

export function AuditLogPanel() {
  const { data: logs = [], isLoading } = useAuditLogs(500);
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
        <CardTitle className="flex items-center gap-2 text-base">
          <ScrollText className="size-4" /> Audit log
          <span className="text-xs font-normal text-muted-foreground">共 {logs.length} 筆</span>
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
          <Skeleton className="h-20" />
        ) : logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">尚無紀錄</p>
        ) : (
          <>
            <ul className="divide-y rounded-md border text-sm">
              {pageRows.map((l) => (
                <li key={l.id} className="flex items-center gap-3 p-2.5">
                  <Badge variant={ACTION_VARIANT[l.action]} className="text-[10px]">
                    {ACTION_LABEL[l.action]}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">
                      <span className="text-muted-foreground">{l.scope}</span>
                      {' · '}
                      <span>{l.summary ?? l.entityId}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {formatTW(l.timestamp, 'yyyy/MM/dd HH:mm:ss')}
                    </div>
                  </div>
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
