import { PageHeader } from '@/components/layout/page-header';
import { StockRadar } from '@/features/stock-radar';

export default function StockRadarPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="股市雷達" description="每天盤前用有論文背書的因子評估持股與自選股：加碼、續抱、減碼或出場" />
      <StockRadar />
    </div>
  );
}
