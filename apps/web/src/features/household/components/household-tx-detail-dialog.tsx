import { CalendarDays, CreditCard, Map as MapIcon, Pencil, PiggyBank, Trash2, User, Users } from 'lucide-react';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { resolveIcon } from '@/lib/icons';
import { useCategories } from '@/features/ledger/hooks';
import { effectiveAmountTWD, type Transaction } from '@/features/ledger/types';
import { householdPortionTWD, sharesOfTx } from '../balance';
import { HOUSEHOLD_FUND_PAYER_ID, canEditLedgerOf, memberCan, type Household } from '../types';
import { useTrip } from '@/features/trips/hooks';
import { MemberChip } from './member-chip';

interface HouseholdTxDetailDialogProps {
  household: Household;
  tx: Transaction | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: (tx: Transaction) => void;
  onDelete: (tx: Transaction) => void;
  /** 沒有完整編輯權但可以改分攤時的入口 */
  onEditSplit?: (tx: Transaction) => void;
  deleting?: boolean;
}

/** 單筆共同支出的完整明細：誰付、各成員分攤、付款方式、誰記的 */
export function HouseholdTxDetailDialog({
  household, tx, open, onOpenChange, onEdit, onDelete, onEditSplit, deleting = false,
}: HouseholdTxDetailDialogProps) {
  const { user } = useAuth();
  const myUid = user?.uid ?? '';
  const { data: categories = [] } = useCategories();
  const { data: trip } = useTrip(tx?.tripId ?? undefined);

  if (!tx) {
    return <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="共同支出明細" contentClassName="sm:max-w-md"><div /></ResponsiveDialog>;
  }

  const category = categories.find((c) => c.key === tx.category);
  const Icon = resolveIcon(category?.icon);
  const total = effectiveAmountTWD(tx);
  const fundPaid = tx.paidByUid === HOUSEHOLD_FUND_PAYER_ID;
  const payerUid = tx.paidByUid ?? tx.payerId ?? tx.userId;
  const payerIsMember = household.memberIds.includes(payerUid);
  const shares = sharesOfTx(tx, household.memberIds);
  const householdPortion = householdPortionTWD(tx, household.memberIds);
  const externalPortion = Math.max(0, total - householdPortion);
  const isMine = tx.userId === myUid;
  /** 自己記的，或對方在設定裡開放「可編輯我的個人支出」給我 */
  const canManage = canEditLedgerOf(household, myUid, tx.userId);
  const canSplit = !canManage && Boolean(onEditSplit) && memberCan(household, myUid, 'canAddExpense');
  const creator = household.members[tx.userId];
  const payerLabel = payerIsMember
    ? <MemberChip member={household.members[payerUid]} suffix={payerUid === myUid ? '（我）' : ''} className="text-sm" />
    : <span>{trip?.members?.find((m) => (m.uid ?? m.name) === payerUid)?.name ?? payerUid}<span className="ml-1 text-[10px] text-muted-foreground">旅伴</span></span>;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="共同支出明細"
      description={household.name}
      contentClassName="sm:max-w-md"
      footer={canManage ? (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-12 flex-1"
            onClick={() => onDelete(tx)}
            disabled={deleting}
          >
            <Trash2 className="size-4" /> 刪除
          </Button>
          <Button type="button" className="h-12 flex-[2]" onClick={() => onEdit(tx)}>
            <Pencil className="size-4" /> 編輯
          </Button>
        </div>
      ) : canSplit ? (
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="h-12 flex-1" onClick={() => onOpenChange(false)}>關閉</Button>
          <Button type="button" className="h-12 flex-[2]" onClick={() => onEditSplit?.(tx)}>
            <Users className="size-4" /> 修改分攤
          </Button>
        </div>
      ) : (
        <Button type="button" variant="outline" className="h-12 w-full" onClick={() => onOpenChange(false)}>關閉</Button>
      )}
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-xl border p-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted">
            <Icon className="size-5" style={{ color: category?.color }} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{category?.name ?? tx.category}</div>
            {tx.note ? <div className="truncate text-xs text-muted-foreground">{tx.note}</div> : null}
          </div>
          <div className="shrink-0 text-right text-xl font-semibold tabular-nums">{formatCurrency(total, 'TWD')}</div>
        </div>

        <dl className="space-y-2 text-sm">
          <Row icon={CalendarDays} label="日期">{formatTW(tx.date, 'yyyy/MM/dd (EEE)')}</Row>
          <Row icon={fundPaid ? PiggyBank : User} label="誰付的">
            {fundPaid
              ? <span className="inline-flex items-center gap-1">公基金<Badge variant="warning" className="h-4 text-[10px]">不計入誰欠誰</Badge></span>
              : payerLabel}
          </Row>
          {tx.tripId ? (
            <Row icon={MapIcon} label="同時歸入旅程">{trip?.name ?? tx.tripId}</Row>
          ) : null}
          <Row icon={CreditCard} label="付款方式">{tx.paymentMethod || '—'}</Row>
          <Row icon={User} label="誰記的">
            <MemberChip member={creator} suffix={tx.userId === myUid ? '（我）' : ''} className="text-sm" />
          </Row>
        </dl>

        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">怎麼分</p>
          {fundPaid ? (
            <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
              由公基金支付，直接從共同基金餘額扣除，不形成成員之間的應收／應付。
            </p>
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {household.memberIds.map((id) => {
                const share = shares[id] ?? 0;
                const pct = total > 0 ? Math.round((share / total) * 100) : 0;
                return (
                  <li key={id} className="flex items-center justify-between gap-2 p-2">
                    <MemberChip member={household.members[id]} suffix={id === myUid ? '（我）' : ''} className="text-sm" />
                    <span className="tabular-nums">
                      {formatCurrency(share, 'TWD')}
                      <span className="ml-1 text-xs text-muted-foreground">({pct}%)</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {!fundPaid && tx.tripId && externalPortion > 0.5 ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              其他旅伴合計 {formatCurrency(externalPortion, 'TWD')}，在旅程「分攤結算」處理；共同帳本只算兩人這 {formatCurrency(householdPortion, 'TWD')}。
            </p>
          ) : null}
          {!fundPaid && payerUid && payerIsMember ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {household.members[payerUid]?.displayName ?? '付款人'} 先墊了 {formatCurrency(householdPortion, 'TWD')}，
              其他人各自那份會算進「誰欠誰」。
            </p>
          ) : !fundPaid && payerUid ? (
            <p className="mt-1.5 text-xs text-muted-foreground">由旅伴付款，兩人各自那份在旅程結算還給他，共同帳本內不形成欠款。</p>
          ) : null}
        </div>

        <p className="text-[11px] text-muted-foreground">
          建立於 {formatTW(tx.createdAt, 'yyyy/MM/dd HH:mm')}
          {tx.updatedAt && tx.updatedAt.getTime() !== tx.createdAt.getTime()
            ? ` · 最後修改 ${formatTW(tx.updatedAt, 'yyyy/MM/dd HH:mm')}`
            : ''}
        </p>
        {!isMine ? (
          <p className="text-[11px] text-muted-foreground">
            {canManage
              ? '這筆是對方記的；對方已開放你編輯，改動會直接寫進對方的帳本。'
              : canSplit
                ? '這筆是對方記的：你可以改分攤（誰付、每人多少），金額與類別只有記錄者能改。'
                : '這筆是對方記的，只有記錄的人能編輯或刪除（對方可在「設定 → 成員與權限」開放編輯）。'}
          </p>
        ) : null}
      </div>
    </ResponsiveDialog>
  );
}

function Row({ icon: Icon, label, children }: { icon: typeof User; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}
