import { useMemo, useState } from 'react';
import { Layers, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { useConfirm } from '@/components/ui/confirm';
import { useAccounts } from '@/features/accounts';
import { useCategories } from '@/features/ledger/hooks';
import { cn, formatCurrency } from '@/lib/utils';
import {
  useCancelInstallmentPlan, useInstallmentPlans, usePostDueInstallments,
} from '../hooks';
import { totalInstallmentRemainingTWD } from '../schedule';
import type { InstallmentPlan } from '../types';
import { InstallmentCard } from './installment-card';
import { InstallmentFormDialog } from './installment-form';

/** 記帳 → 分期：建立 / 檢視 / 取消信用卡分期 */
export function InstallmentsPanel() {
  const { data: plans = [], isLoading } = useInstallmentPlans();
  const { data: accounts = [] } = useAccounts();
  const { data: categories = [] } = useCategories();
  const cancel = useCancelInstallmentPlan();
  const postNow = usePostDueInstallments();
  const confirm = useConfirm();
  const [formOpen, setFormOpen] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);
  const categoryName = useMemo(() => new Map(categories.map((c) => [c.key, c.name])), [categories]);
  const active = useMemo(() => plans.filter((p) => p.status === 'active'), [plans]);
  const closed = useMemo(() => plans.filter((p) => p.status !== 'active'), [plans]);
  const remainingTotal = useMemo(() => totalInstallmentRemainingTWD(active), [active]);

  async function handleCancel(plan: InstallmentPlan) {
    const ok = await confirm({
      title: '取消這筆分期？',
      description: `${plan.title} 已入帳的 ${plan.paidPeriods} 期會保留，之後的期數不再自動入帳。`,
      confirmText: '取消分期',
    });
    if (!ok) return;
    try {
      await cancel.mutateAsync(plan.id);
    } catch (err) {
      // toast 已在 mutation onError 處理
      console.error('[installmentCancel]', err);
    }
  }

  function renderPlan(plan: InstallmentPlan) {
    return (
      <InstallmentCard
        key={plan.id}
        plan={plan}
        cardName={accountName.get(plan.cardAccountId) ?? '（已刪除的卡）'}
        categoryName={categoryName.get(plan.category) ?? plan.category}
        onCancel={(p) => void handleCancel(p)}
        cancelling={cancel.isPending}
      />
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers className="size-4" /> 信用卡分期
            </CardTitle>
            <div className="mt-1 text-xs text-muted-foreground">
              進行中 {active.length} 筆 · 未入帳 {formatCurrency(remainingTotal)}（已計入淨值負債）
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => postNow.mutate()}
              disabled={postNow.isPending || active.length === 0}
              title="立即把已到期、尚未入帳的期數記帳（平常每天 01:00 自動執行）"
            >
              <RefreshCw className={cn('size-4', postNow.isPending && 'animate-spin')} /> 立即入帳
            </Button>
            <Button size="sm" onClick={() => setFormOpen(true)}>
              <Plus className="size-4" /> 新增分期
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中…</p>
          ) : plans.length === 0 ? (
            <EmptyState
              icon={Layers}
              title="還沒有分期"
              description="刷卡分期時在這裡建立，每期會在入帳日自動記一筆支出到信用卡，月支出跟帳單對得起來。"
            />
          ) : (
            <>
              {active.length > 0 ? (
                <ul className="divide-y rounded-md border">{active.map(renderPlan)}</ul>
              ) : (
                <p className="text-sm text-muted-foreground">目前沒有進行中的分期。</p>
              )}
              {closed.length > 0 ? (
                <div className="space-y-2">
                  <Button size="sm" variant="ghost" onClick={() => setShowClosed((v) => !v)}>
                    {showClosed ? '隱藏' : '顯示'}已繳完 / 已取消（{closed.length}）
                  </Button>
                  {showClosed ? <ul className="divide-y rounded-md border">{closed.map(renderPlan)}</ul> : null}
                </div>
              ) : null}
            </>
          )}
          <p className="text-[11px] text-muted-foreground">
            每期金額 = (總額 + 手續費) ÷ 期數（取整數），最後一期吸收尾差。取消只會停止之後的入帳，已入帳的交易保留在記帳裡。
          </p>
        </CardContent>
      </Card>
      <InstallmentFormDialog open={formOpen} onOpenChange={setFormOpen} />
    </>
  );
}
