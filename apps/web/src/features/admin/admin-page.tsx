import { PageHeader } from '@/components/layout/page-header';
import { ErrorBoundary } from '@/components/error-boundary';
import { AccessPanel } from '@/features/access';

export default function AdminPage() {
  return (
    <ErrorBoundary scope="Admin">
      <PageHeader title="管理員" description="登入白名單、使用者角色、共同帳本成員與權限" />
      <AccessPanel />
    </ErrorBoundary>
  );
}
