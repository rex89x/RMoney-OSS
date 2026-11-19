import { Link } from 'react-router-dom';
import { Inbox, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useInboxItems } from '../hooks';
import { InboxList } from './inbox-list';

const PREVIEW_LIMIT = 5;

/** 首頁最上方「需要處理」卡：沒有事項時不渲染 */
export function InboxDashboardCard() {
  const { items, isLoading } = useInboxItems();

  if (isLoading && items.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><Inbox className="size-4" /> 需要處理</CardTitle>
        </CardHeader>
        <CardContent><Skeleton className="h-16 w-full" /></CardContent>
      </Card>
    );
  }
  if (items.length === 0) return null;

  const urgent = items.filter((i) => i.severity === 'urgent').length;

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <Inbox className="size-4" /> 需要處理
            <span className="rounded-full bg-primary/10 px-2 text-xs font-medium text-primary">{items.length}</span>
            {urgent > 0 ? (
              <span className="rounded-full bg-destructive/10 px-2 text-xs font-medium text-destructive">{urgent} 急</span>
            ) : null}
          </span>
          <Button size="sm" variant="ghost" asChild>
            <Link to="/inbox">全部 <ArrowRight className="size-3.5" /></Link>
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <InboxList items={items} compact limit={PREVIEW_LIMIT} />
        {items.length > PREVIEW_LIMIT ? (
          <p className="mt-1 px-1 text-xs text-muted-foreground">還有 {items.length - PREVIEW_LIMIT} 項</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
