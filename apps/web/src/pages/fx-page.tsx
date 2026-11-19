import { FxView } from '@/features/fx';
import { PageHeader } from '@/components/layout/page-header';

export default function FxPage() {
  return (
    <div>
      <PageHeader title="匯率" description="即時匯率與警報" />
      <FxView />
    </div>
  );
}
