import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, CartesianGrid,
} from 'recharts';
import {
  Check, ChevronDown, ChevronRight, Coffee, Copy, Edit3, Gift, Mail, Plus, Receipt, Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DataTablePagination, DataTableToolbar, useDataTable, type FilterDef,
} from '@/components/data-table';
import { formatCurrency, cn } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { usePayoutGroups, useUpdatePayoutGroup } from '../hooks';
import {
  isFullyPaid,
  paidTotalTWD,
  participantBaseAmountTWD,
  participantSharedContributionTWD,
  pendingTotalTWD,
  type PayoutGroup,
  type PayoutParticipant,
} from '../types';
import { PayoutGroupDialog } from './payout-group-dialog';
import { PayoutMailExportDialog } from './payout-mail-export-dialog';
import { buildPayoutMailPlainText } from '../mail-export';

export function PayoutGroupsPanel() {
  const { data: groups = [], isLoading } = usePayoutGroups();
  const update = useUpdatePayoutGroup();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PayoutGroup | null>(null);
  const [exporting, setExporting] = useState<PayoutGroup | null>(null);
  const [expandedPaid, setExpandedPaid] = useState<Set<string>>(new Set());

  function togglePaidExpand(id: string) {
    setExpandedPaid((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const summary = useMemo(() => {
    const totalPending = groups.reduce((s, g) => s + pendingTotalTWD(g), 0);
    const totalCollected = groups.reduce((s, g) => s + paidTotalTWD(g), 0);
    const openCount = groups.filter((g) => !isFullyPaid(g)).length;
    return { totalPending, totalCollected, openCount };
  }, [groups]);

  // 按月份聚合：用於小圖表 + 月份篩選下拉
  const monthBuckets = useMemo(() => {
    const map = new Map<string, { month: string; pending: number; collected: number }>();
    for (const g of groups) {
      const k = formatTW(g.date, 'yyyy-MM');
      const slot = map.get(k) ?? { month: k, pending: 0, collected: 0 };
      slot.pending += pendingTotalTWD(g);
      slot.collected += paidTotalTWD(g);
      map.set(k, slot);
    }
    return Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month)).slice(-6);
  }, [groups]);

  const monthOptions = useMemo(() => {
    const months = new Set<string>();
    for (const g of groups) months.add(formatTW(g.date, 'yyyy-MM'));
    return Array.from(months).sort().reverse().map((m) => ({ value: m, label: m }));
  }, [groups]);

  const filters: FilterDef[] = useMemo(() => [
    {
      id: 'status',
      label: '狀態',
      kind: 'select',
      options: [
        { value: 'open', label: '未結清' },
        { value: 'paid', label: '已全收' },
      ],
    },
    ...(monthOptions.length > 0 ? [{
      id: 'month',
      label: '月份',
      kind: 'select' as const,
      options: monthOptions,
    }] : []),
  ], [monthOptions]);

  const accessor = useMemo(() => (row: PayoutGroup, id: string) => {
    switch (id) {
      case 'status': return isFullyPaid(row) ? 'paid' : 'open';
      case 'month': return formatTW(row.date, 'yyyy-MM');
      case 'title': return row.title;
      case 'note': return row.note ?? '';
      case 'participantNames': return row.participants.map((p) => p.name).join(' ');
      default: return (row as unknown as Record<string, unknown>)[id];
    }
  }, []);

  const sorted = useMemo(
    () => [...groups].sort((a, b) => b.date.getTime() - a.date.getTime()),
    [groups],
  );

  const table = useDataTable<PayoutGroup>({
    data: sorted,
    accessor,
    searchFields: ['title', 'note', 'participantNames'],
    filters,
    pageSize: 10,
    urlKey: 'pg',
  });

  function openNew() { setEditing(null); setDialogOpen(true); }
  function openEdit(g: PayoutGroup) { setEditing(g); setDialogOpen(true); }

  async function togglePaid(g: PayoutGroup, p: PayoutParticipant) {
    const next = g.participants.map((x) => x.id === p.id
      ? { ...x, paidAt: x.paidAt ? null : new Date() }
      : x);
    await update.mutateAsync({
      id: g.id,
      patch: { participants: next, totalAmountTWD: g.totalAmountTWD },
    });
  }

  async function copyReminderText(g: PayoutGroup) {
    const message = buildPayoutMailPlainText(g);
    try {
      await navigator.clipboard.writeText(message);
      toast.success('已複製分帳明細');
    } catch {
      toast.error('複製失敗，請手動選取');
    }
  }

  return (
    <div className="space-y-4">
      {/* Summary + 新增 */}
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 pb-2 sm:flex-row sm:items-center">
          <CardTitle className="flex items-center gap-2 text-base">
            <Coffee className="size-4" /> 墊付團
            <span className="text-xs font-normal text-muted-foreground">
              （我先付，再跟其他人收錢）
            </span>
          </CardTitle>
          <Button size="sm" onClick={openNew}>
            <Plus className="size-4" /> 新增墊付團
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="待收金額" value={formatCurrency(summary.totalPending)} tone="warning" />
            <Stat label="已收金額" value={formatCurrency(summary.totalCollected)} tone="success" />
            <Stat label="未結清團" value={`${summary.openCount}`} tone="default" />
          </div>
          {monthBuckets.length > 0 ? (
            <MonthlySummaryChart buckets={monthBuckets} />
          ) : null}
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-md" />)}
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="space-y-2 py-10 text-center text-sm text-muted-foreground">
            <Coffee className="mx-auto size-6" />
            <p>還沒有墊付團。點上方「新增墊付團」開新的下午茶 / 揪團。</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <DataTableToolbar table={table} searchPlaceholder="搜尋活動 / 備註 / 參與者…" />
          {table.rows.length === 0 ? (
            <Card>
              <CardContent className="py-6 text-center text-sm text-muted-foreground">
                沒有符合條件的墊付團
              </CardContent>
            </Card>
          ) : (
            table.rows.map((g) => {
              const pending = pendingTotalTWD(g);
              const collected = paidTotalTWD(g);
              const allPaid = isFullyPaid(g);
              const isExpanded = !allPaid || expandedPaid.has(g.id);
              return (
                <Card key={g.id}>
                  <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
                    <button
                      type="button"
                      onClick={() => allPaid && togglePaidExpand(g.id)}
                      className={cn(
                        'flex min-w-0 flex-1 items-start gap-2 text-left',
                        allPaid ? 'cursor-pointer' : 'cursor-default',
                      )}
                      aria-expanded={isExpanded}
                      aria-label={allPaid ? (isExpanded ? '收合明細' : '展開明細') : undefined}
                    >
                      {allPaid ? (
                        isExpanded
                          ? <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground" />
                          : <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
                      ) : null}
                      <div className="min-w-0">
                        <CardTitle className="flex items-center gap-2 truncate text-base">
                          {g.title}
                          {allPaid ? (
                            <Badge variant="success">全員已繳</Badge>
                          ) : (
                            <Badge variant="secondary">{g.participants.filter((p) => p.paidAt).length}/{g.participants.length} 已繳</Badge>
                          )}
                        </CardTitle>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {formatTW(g.date, 'yyyy/MM/dd')} · 總 {formatCurrency(g.totalAmountTWD)} · 已收 {formatCurrency(collected)} · 待收 {formatCurrency(pending)}
                        </p>
                      </div>
                    </button>
                    <div className="flex shrink-0 gap-1">
                      <Button size="icon-sm" variant="outline" onClick={() => void copyReminderText(g)} title="複製催繳訊息">
                        <Copy className="size-3.5" />
                      </Button>
                      <Button size="icon-sm" variant="outline" onClick={() => setExporting(g)} title="產生 Email HTML 明細">
                        <Mail className="size-3.5" />
                      </Button>
                      <Button size="icon-sm" variant="outline" onClick={() => openEdit(g)} title="編輯明細">
                        <Edit3 className="size-3.5" />
                      </Button>
                    </div>
                  </CardHeader>
                  {isExpanded ? (
                  <CardContent className="px-0 pb-2">
                    <ul className="divide-y">
                      {g.participants.map((p) => (
                        <li key={p.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                          <button
                            type="button"
                            onClick={() => void togglePaid(g, p)}
                            className={cn(
                              'flex size-7 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                              p.paidAt
                                ? 'border-emerald-500 bg-emerald-500 text-white'
                                : 'border-amber-500 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20',
                            )}
                            aria-label={p.paidAt ? '取消已繳' : '標記已繳'}
                          >
                            <Check className={cn('size-4', !p.paidAt && 'opacity-0')} />
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <div className="truncate font-medium">{p.name}</div>
                              {p.sharedByOthers ? (
                                <Gift className="size-3.5 shrink-0 text-amber-500" />
                              ) : null}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {p.paidAt
                                ? `已繳 ${formatTW(p.paidAt, 'MM/dd HH:mm')}${p.paymentMethod ? ` · ${p.paymentMethod}` : ''}`
                                : '待收（點左側勾選標記已繳）'}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {formatParticipantSplitNote(p)}
                            </div>
                          </div>
                          <Badge variant={p.paidAt ? 'success' : 'destructive'} className="shrink-0">
                            {p.paidAt ? '已收' : '待收'}
                          </Badge>
                          <div className={cn(
                            'shrink-0 text-sm font-semibold tabular-nums',
                            p.paidAt ? 'text-emerald-500' : 'text-amber-500',
                          )}>
                            {formatCurrency(p.amountTWD)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                  ) : null}
                </Card>
              );
            })
          )}
          <DataTablePagination table={table} pageSizes={[5, 10, 25, 50]} />
        </>
      )}

      <PayoutGroupDialog open={dialogOpen} onOpenChange={setDialogOpen} group={editing} />
      <PayoutMailExportDialog
        open={Boolean(exporting)}
        onOpenChange={(open) => {
          if (!open) setExporting(null);
        }}
        group={exporting}
      />
    </div>
  );
}

function MonthlySummaryChart({ buckets }: { buckets: Array<{ month: string; pending: number; collected: number }> }) {
  // 兩條 bar：已收 (emerald) / 待收 (amber)；recharts 用 stack 顯示總額
  const data = buckets.map((b) => ({
    month: b.month.slice(2), // YY-MM
    已收: Math.round(b.collected),
    待收: Math.round(b.pending),
  }));
  return (
    <div className="rounded-md border p-2">
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">近 6 月活動量</div>
      <div className="h-[120px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
            <XAxis dataKey="month" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} width={36} />
            <Tooltip formatter={(v: number) => formatCurrency(v)} />
            <Bar dataKey="已收" stackId="a" fill="#10b981">
              {data.map((_, i) => <Cell key={i} />)}
            </Bar>
            <Bar dataKey="待收" stackId="a" fill="#f59e0b">
              {data.map((_, i) => <Cell key={i} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function formatParticipantSplitNote(p: PayoutParticipant): string {
  const base = participantBaseAmountTWD(p);
  const contribution = participantSharedContributionTWD(p);
  if (p.sharedByOthers) return `原始 ${formatCurrency(base)}，由其他同仁分攤`;
  if (contribution > 0) return `原始 ${formatCurrency(base)}，含分攤 ${formatCurrency(contribution)}`;
  return `原始 ${formatCurrency(base)}`;
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'default' | 'warning' | 'success' }) {
  const cls = {
    default: 'text-foreground',
    warning: 'text-amber-500',
    success: 'text-emerald-500',
  }[tone];
  const Icon = tone === 'warning' ? Receipt : tone === 'success' ? Users : Coffee;
  return (
    <div className="flex items-center gap-2 rounded-md border p-2.5">
      <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-full bg-muted', cls)}>
        <Icon className="size-3.5" />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className={cn('truncate text-base font-semibold tabular-nums', cls)}>{value}</div>
      </div>
    </div>
  );
}
