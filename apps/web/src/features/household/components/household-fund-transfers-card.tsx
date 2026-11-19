import { useState } from 'react';
import { ArrowRight, KeyRound, PiggyBank, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import { cn, formatCurrency } from '@/lib/utils';
import { useHouseholdFundSummary, useUpdateHousehold } from '../hooks';
import { memberCan, type Household } from '../types';
import { HouseholdFundReimburseDialog } from './household-fund-reimburse-dialog';
import { MemberChip } from './member-chip';

const NO_KEEPER = '__none__';

interface HouseholdFundTransfersCardProps {
  household: Household;
  /**
   * compact：總覽用，只在有待撥還時出現，不顯示歷史與保管人設定。
   * 完整版（公基金分頁）：一律顯示有代墊紀錄的成員、可指定保管人。
   */
  compact?: boolean;
}

/**
 * 公基金轉帳待辦：公基金還要轉給誰多少（先墊 − 已撥還）。兩位成員都看得到，
 * 文字依「我」的角色調整：保管人看到「請從公基金轉 X 給 Y」、收款人看到「公基金還要轉給你 X」。
 * 撥還按鈕與保管人設定需要「公基金管理」權限（canManageFund）。
 */
export function HouseholdFundTransfersCard({ household, compact = false }: HouseholdFundTransfersCardProps) {
  const { user } = useAuth();
  const myUid = user?.uid ?? '';
  const { summary } = useHouseholdFundSummary(household);
  const update = useUpdateHousehold();
  const [reimburseUid, setReimburseUid] = useState<string | null>(null);
  const canManage = memberCan(household, myUid, 'canManageFund');
  const keeper = household.fundKeeperUid ?? null;
  const keeperName = keeper ? household.members[keeper]?.displayName ?? '保管人' : null;

  const rows = household.memberIds.filter((uid) =>
    (summary.advancedByMember[uid] ?? 0) > 0 || (summary.reimbursedByMember[uid] ?? 0) > 0);
  const pending = household.memberIds
    .map((uid) => ({ uid, amount: Math.round(summary.owedToMember[uid] ?? 0) }))
    .filter((row) => row.amount > 0);
  if (compact ? pending.length === 0 : rows.length === 0 && !canManage) return null;

  function instruction(uid: string, amount: number): string {
    const name = household.members[uid]?.displayName ?? '成員';
    if (uid === myUid) return `公基金還要轉給你 ${formatCurrency(amount)}`;
    if (keeper === myUid) return `請從公基金帳戶轉 ${formatCurrency(amount)} 給 ${name}`;
    return `${keeperName ? `${keeperName}要從公基金` : '公基金要'}轉 ${formatCurrency(amount)} 給 ${name}`;
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 space-y-0 pb-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base"><Undo2 className="size-4" /> 公基金轉帳待辦</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {summary.outstandingTWD > 0
              ? `公基金共要轉出 ${formatCurrency(summary.outstandingTWD)} 給先墊的人`
              : rows.length > 0 ? '代墊都已撥還結清' : '帳本負擔的支出標示「某人先墊」後，這裡會列出公基金要轉給誰多少'}
          </p>
        </div>
        {!compact ? (
          <div className="flex shrink-0 items-center gap-1.5 text-xs">
            <KeyRound className="size-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">保管人</span>
            {canManage ? (
              <Select
                value={keeper ?? NO_KEEPER}
                onValueChange={(value) => update.mutate({
                  id: household.id,
                  patch: { fundKeeperUid: value === NO_KEEPER ? null : value },
                })}
                disabled={update.isPending}
              >
                <SelectTrigger className="h-8 w-32 text-xs" aria-label="公基金保管人"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_KEEPER}>未指定</SelectItem>
                  {household.memberIds.map((uid) => (
                    <SelectItem key={uid} value={uid}>
                      {household.members[uid]?.displayName ?? uid}{uid === myUid ? '（我）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="font-medium">{keeperName ?? '未指定'}</span>
            )}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2">
        {pending.length > 0 ? (
          <ul className="space-y-2">
            {pending.map(({ uid, amount }) => {
              const forMe = uid === myUid || keeper === myUid;
              return (
                <li
                  key={uid}
                  className={cn('flex flex-wrap items-center gap-2 rounded-lg border p-2.5 text-sm', forMe && 'border-warning/50 bg-warning/5')}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <PiggyBank className="size-4 shrink-0 text-muted-foreground" />
                    <ArrowRight className="size-3.5 text-muted-foreground" />
                    <MemberChip member={household.members[uid]} suffix={uid === myUid ? '（我）' : ''} className="text-sm" />
                  </span>
                  <span className="min-w-0 flex-1 break-words text-xs text-muted-foreground">{instruction(uid, amount)}</span>
                  <span className="shrink-0 font-semibold tabular-nums text-warning">{formatCurrency(amount)}</span>
                  {canManage ? (
                    <Button size="sm" className="h-8 shrink-0" onClick={() => setReimburseUid(uid)}>已轉，記錄撥還</Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {!compact && rows.length > 0 ? (
          <ul className="divide-y text-xs">
            {rows.map((uid) => {
              const due = Math.round(summary.owedToMember[uid] ?? 0);
              return (
                <li key={uid} className="flex flex-wrap items-center gap-2 py-2">
                  <MemberChip member={household.members[uid]} suffix={uid === myUid ? '（我）' : ''} className="text-xs" />
                  <span className="text-muted-foreground">
                    先墊 {formatCurrency(summary.advancedByMember[uid] ?? 0)} · 已撥還 {formatCurrency(summary.reimbursedByMember[uid] ?? 0)}
                  </span>
                  <Badge variant={due > 0 ? 'warning' : due < 0 ? 'destructive' : 'success'} className="ml-auto">
                    {due > 0 ? `欠 ${formatCurrency(due)}` : due < 0 ? `多撥 ${formatCurrency(-due)}` : '已結清'}
                  </Badge>
                </li>
              );
            })}
          </ul>
        ) : null}

        {!canManage && pending.length > 0 ? (
          <p className="text-[11px] text-muted-foreground">你沒有「公基金管理」權限，轉帳後請保管人或建立者記錄撥還。</p>
        ) : null}
        {!compact ? (
          <p className="text-[11px] text-muted-foreground">
            共同支出選「帳本負擔（公基金）」並標示誰先墊，公基金就會欠那個人；保管人實際從公基金帳戶轉帳後按「已轉，記錄撥還」即結清（可部分撥還）。
          </p>
        ) : null}
      </CardContent>
      <HouseholdFundReimburseDialog
        household={household}
        open={Boolean(reimburseUid)}
        toUid={reimburseUid}
        onOpenChange={(next) => { if (!next) setReimburseUid(null); }}
      />
    </Card>
  );
}
