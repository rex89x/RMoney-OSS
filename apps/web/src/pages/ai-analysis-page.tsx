import { PageHeader } from '@/components/layout/page-header';
import { ClaudeAnalysisPanel } from '@/features/claude-analysis';
import { McpAccessCard } from '@/features/mcp-access';

export default function AiAnalysisPage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="AI 分析"
        description="Claude 依任務自己查需要的記帳、投資與旅遊資料來分析；每次都會先估算費用，確認後才執行。"
      />
      <ClaudeAnalysisPanel />
      <McpAccessCard />
    </div>
  );
}
