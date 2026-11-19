import { useSearchParams } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { useTheme } from '@/hooks/use-theme';
import { signOutAndClear, useAuth } from '@/hooks/use-auth';
import { CategoryManager } from '@/features/ledger/components/category-manager';
import { RecurringManager } from '@/features/ledger/components/recurring-manager';
import { BudgetEditor } from '@/features/ledger/components/budget-editor';
import { PageHeader } from '@/components/layout/page-header';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { ScrollTabsList } from '@/components/ui/scroll-tabs';
import { BootstrapPanel } from './components/bootstrap-panel';
import { PaymentMethodsPanel } from './components/payment-methods-panel';
import { NotificationsPanel } from './components/notifications-panel';
import { FxPairsPanel } from './components/fx-pairs-panel';
import { DataTransferPanel } from './components/data-transfer-panel';
import { ErrorLogsPanel } from './components/error-logs-panel';
import { CreditCardBillsPanel } from '@/features/billing';
import { NetWorthPanel } from '@/features/net-worth';
import { AccountsPanel } from '@/features/accounts';
import { SubscriptionsPanel } from '@/features/subscriptions';
import { ScheduledPaymentsPanel } from '@/features/scheduled-payments';
import { GoalsPanel } from '@/features/goals';
import { AuditLogPanel } from '@/features/audit';
import { EInvoiceImportPanel } from '@/features/einvoice';
import { ErrorBoundary } from '@/components/error-boundary';
import { AccessPanel } from '@/features/access';
import { AiBudgetPanel } from '@/features/ai-budget';

export function SettingsPage() {
  const { mode, setMode } = useTheme();
  const { profile, isMember, isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  // member（共同帳本成員）只有一般設定
  const tab = isMember ? 'general' : (params.get('tab') ?? 'general');
  function setTab(v: string) {
    const next = new URLSearchParams(params);
    next.set('tab', v);
    setParams(next, { replace: true });
  }

  return (
    <ErrorBoundary scope="Settings">
      <PageHeader title="設定" description="主題、類別、預算、週期性、資料初始化" />

      <Tabs value={tab} onValueChange={setTab}>
        <ScrollTabsList
          aria-label="設定分頁"
          value={tab}
          items={[
            { value: 'general', label: '一般' },
          ...(isMember ? [] : [
            { value: 'categories', label: '類別' },
            { value: 'accounts', label: '帳戶' },
            { value: 'payment', label: '支付' },
            { value: 'bills', label: '帳單' },
            { value: 'networth', label: '淨值' },
            { value: 'subscriptions', label: '訂閱' },
            { value: 'scheduled', label: '排程' },
            { value: 'goals', label: '目標' },
            { value: 'budget', label: '預算' },
            { value: 'ai-budget', label: 'AI 額度' },
            { value: 'recurring', label: '週期' },
            { value: 'notifications', label: '通知' },
            { value: 'fx', label: '匯率' },
            { value: 'einvoice', label: '發票' },
            { value: 'data', label: '資料' },
            ...(isAdmin ? [{ value: 'access', label: '權限' }] : []),
          ]),
          ]}
        />

        <TabsContent value="general" className="space-y-4">
          <Card>
            <CardHeader><CardTitle>外觀</CardTitle></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div>
                <Label>主題模式</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as 'auto' | 'light' | 'dark')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">跟隨系統 (Auto)</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>帳戶</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>Email: {profile?.email}</div>
              <div>角色: {profile?.role}</div>
              <Button variant="destructive" onClick={() => void signOutAndClear()}>
                <LogOut className="size-4" /> 登出
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="categories">
          <CategoryManager />
        </TabsContent>

        <TabsContent value="accounts">
          <AccountsPanel />
        </TabsContent>

        <TabsContent value="payment">
          <PaymentMethodsPanel />
        </TabsContent>

        <TabsContent value="bills">
          <CreditCardBillsPanel />
        </TabsContent>

        <TabsContent value="networth">
          <NetWorthPanel />
        </TabsContent>

        <TabsContent value="subscriptions">
          <SubscriptionsPanel />
        </TabsContent>

        <TabsContent value="scheduled">
          <ScheduledPaymentsPanel />
        </TabsContent>

        <TabsContent value="einvoice">
          <EInvoiceImportPanel />
        </TabsContent>

        <TabsContent value="goals">
          <GoalsPanel />
        </TabsContent>

        <TabsContent value="budget">
          <BudgetEditor />
        </TabsContent>

        <TabsContent value="ai-budget">
          <AiBudgetPanel />
        </TabsContent>

        <TabsContent value="recurring">
          <RecurringManager />
        </TabsContent>

        <TabsContent value="notifications" className="space-y-4">
          <NotificationsPanel />
        </TabsContent>

        <TabsContent value="fx" className="space-y-4">
          <FxPairsPanel />
        </TabsContent>

        <TabsContent value="data" className="space-y-4">
          <BootstrapPanel />
          <DataTransferPanel />
          <AuditLogPanel />
          <ErrorLogsPanel />
        </TabsContent>

        <TabsContent value="access">
          <AccessPanel />
        </TabsContent>
      </Tabs>
    </ErrorBoundary>
  );
}
