import { PageHeader } from '@/components/layout/page-header';
import { FlightRadar } from '@/features/flight-watches';

export default function FlightWatchesPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="機票雷達" description="追蹤多條航線與日期區段的票價，比較出遊日期、航空公司與艙等" />
      <FlightRadar />
    </div>
  );
}
