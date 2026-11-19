import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BarChart3, Eye, FileText, HandCoins, LayoutDashboard, PiggyBank, Plus, ReceiptText, Settings, Target, TrendingUp, Users,
  type LucideIcon,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { ScrollTabsList } from '@/components/ui/scroll-tabs';
import { ErrorBoundary } from '@/components/error-boundary';
import { useAuth } from '@/hooks/use-auth';
import {
  HouseholdEntriesList, HouseholdEntryDialog, HouseholdFundPanel, HouseholdInsights, HouseholdMonthlyReport, HouseholdOverview,
  HouseholdSettingsPanel, HouseholdSetupCard, MemberChip, SettlementsList, SharedLedgerPanel,
  ledgerSharersFor, memberCan, useHousehold, type Household,
} from '@/features/household';
import { GoalsPanel } from '@/features/goals';
import { HouseholdTelegramCard, JointInvestmentPanel } from '@/features/joint-investments';

interface SectionContext {
  household: Household;
  ready: boolean;
  sharers: string[];
  partnerLabel: string;
  navigate: (tab: string) => void;
}

interface SharedSection {
  id: string;
  label: (ctx: SectionContext) => string;
  icon: LucideIcon;
  /** 還沒有第二位成員時能不能點 */
  availableBeforeReady?: boolean;
  visible?: (ctx: SectionContext) => boolean;
  render: (ctx: SectionContext) => ReactNode;
}

/**
 * /shared 的分頁設定 —— 新增分頁只要在這裡加一筆（URL `?tab=` 用 id）。
 * 順序 = 使用頻率：先看總覽 / 交易 / 投資，設定放最後。
 */
const SECTIONS: SharedSection[] = [
  { id: 'overview', label: () => '總覽', icon: LayoutDashboard, render: (c) => <HouseholdOverview household={c.household} onNavigate={c.navigate} /> },
  { id: 'txs', label: () => '交易', icon: ReceiptText, render: (c) => <HouseholdEntriesList household={c.household} /> },
  {
    id: 'insights', label: () => '分析', icon: BarChart3,
    render: (c) => <ErrorBoundary scope="HouseholdInsights"><HouseholdInsights household={c.household} /></ErrorBoundary>,
  },
  {
    id: 'invest', label: () => '投資', icon: TrendingUp,
    render: (c) => <ErrorBoundary scope="JointInvestments"><JointInvestmentPanel household={c.household} /></ErrorBoundary>,
  },
  { id: 'fund', label: () => '公基金', icon: PiggyBank, render: (c) => <HouseholdFundPanel household={c.household} /> },
  { id: 'report', label: () => '月報', icon: FileText, render: (c) => <HouseholdMonthlyReport household={c.household} /> },
  { id: 'settlements', label: () => '結算', icon: HandCoins, render: (c) => <SettlementsList household={c.household} /> },
  {
    // 誰把個人支出分享給我（通常只有一位）→ 多一個唯讀分頁
    id: 'partner', label: (c) => c.partnerLabel, icon: Eye,
    visible: (c) => c.sharers.length > 0,
    render: (c) => <SharedLedgerPanel household={c.household} />,
  },
  { id: 'goals', label: () => '目標', icon: Target, render: (c) => <GoalsPanel householdId={c.household.id} /> },
  {
    id: 'settings', label: () => '設定', icon: Settings, availableBeforeReady: true,
    render: (c) => (
      <div className="space-y-4">
        <HouseholdSettingsPanel household={c.household} />
        {c.ready ? <HouseholdTelegramCard household={c.household} /> : null}
      </div>
    ),
  },
];

const DESCRIPTION = '兩人的分帳、共同投資與共同目標';

export default function SharedPage() {
  const { isOwner, user } = useAuth();
  const { household, isLoading } = useHousehold();
  const [params, setParams] = useSearchParams();
  const [entryOpen, setEntryOpen] = useState(false);
  const setTab = (v: string) => {
    const next = new URLSearchParams(params);
    if (v === 'overview') next.delete('tab'); else next.set('tab', v);
    setParams(next, { replace: true });
  };

  if (isLoading) {
    return (
      <>
        <PageHeader title="共同" description={DESCRIPTION} />
        <Skeleton className="h-40" />
      </>
    );
  }

  if (!household) {
    return (
      <ErrorBoundary scope="Shared">
        <PageHeader title="共同" description={DESCRIPTION} />
        {isOwner ? <HouseholdSetupCard /> : (
          <EmptyState icon={Users} title="尚未加入任何共同帳本" description="請對方在「共同 → 設定」用你的 email 邀請；若剛被邀請，重新登入一次即可。" />
        )}
      </ErrorBoundary>
    );
  }

  const ready = household.memberIds.length >= 2;
  const sharers = ledgerSharersFor(household, user?.uid);
  const partnerName = household.members[sharers[0] ?? '']?.displayName ?? '對方';
  const ctx: SectionContext = {
    household,
    ready,
    sharers,
    partnerLabel: sharers.length === 1
      ? `${partnerName.length > 4 ? `${partnerName.slice(0, 4)}…` : partnerName}的帳`
      : '對方的帳',
    navigate: setTab,
  };
  const sections = SECTIONS.filter((s) => !s.visible || s.visible(ctx));
  const rawTab = params.get('tab') ?? 'overview';
  const requested = sections.find((s) => s.id === rawTab) ?? sections[0];
  const active = !ready && !requested?.availableBeforeReady ? 'settings' : (requested?.id ?? 'overview');
  const canAdd = ready && memberCan(household, user?.uid, 'canAddExpense');

  return (
    <ErrorBoundary scope="Shared">
      <PageHeader
        title={household.name}
        description={ready ? DESCRIPTION : '還沒有第二位成員，先到「設定」邀請'}
        className="mb-3"
        actions={(
          <Button onClick={() => setEntryOpen(true)} disabled={!canAdd}>
            <Plus className="size-4" /> 新增共同支出
          </Button>
        )}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {household.memberIds.map((id) => <MemberChip key={id} member={household.members[id]} className="text-xs" />)}
      </div>

      <Tabs value={active} onValueChange={setTab}>
        {/* 手機上分頁列黏在頂端，長頁面往下捲也能直接切換 */}
        <div className="sticky top-0 z-20 -mx-4 bg-background/95 px-4 pb-2 pt-[calc(env(safe-area-inset-top)+0.25rem)] backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:static lg:mx-0 lg:px-0 lg:pt-0">
          <ScrollTabsList
            aria-label="共同帳本分頁"
            value={active}
            items={sections.map((s) => ({
              value: s.id,
              label: s.label(ctx),
              icon: s.icon,
              disabled: !ready && !s.availableBeforeReady,
            }))}
          />
        </div>
        {sections.map((s) => (
          <TabsContent key={s.id} value={s.id} className="mt-2 min-w-0">
            {s.id === active ? s.render(ctx) : null}
          </TabsContent>
        ))}
      </Tabs>

      <HouseholdEntryDialog household={household} open={entryOpen} onOpenChange={setEntryOpen} />
    </ErrorBoundary>
  );
}
