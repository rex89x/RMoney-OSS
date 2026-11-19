import { PageHeader } from '@/components/layout/page-header';
import { TaifexSim } from '@/features/taifex';

export default function TaifexPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="台指期模擬" description="日線波段策略的虛擬交易：技術面 + 外資籌碼 + 選擇權 PCR + Claude 輿情，隔日開盤以虛擬單成交" />
      <TaifexSim />
    </div>
  );
}
