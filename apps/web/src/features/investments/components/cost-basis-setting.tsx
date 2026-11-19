import { Layers } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCostBasisMethod, useSetCostBasisMethod } from '../hooks';
import { DEFAULT_COST_BASIS_METHOD } from '../cost-basis';

/** 投資設定：賣出成本法切換（只影響之後的賣出，已落帳的已實現紀錄不會重算） */
export function CostBasisSetting() {
  const { data: method = DEFAULT_COST_BASIS_METHOD, isLoading } = useCostBasisMethod();
  const save = useSetCostBasisMethod();

  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Layers className="size-4" /> 賣出成本計算方式
          </div>
          <Tabs
            value={method}
            onValueChange={(v) => {
              const next = v === 'fifo' ? 'fifo' : 'average';
              if (next !== method) save.mutate(next);
            }}
          >
            <TabsList>
              <TabsTrigger value="average" className="text-xs" disabled={isLoading || save.isPending}>平均成本</TabsTrigger>
              <TabsTrigger value="fifo" className="text-xs" disabled={isLoading || save.isPending}>FIFO 先進先出</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          台股多用平均成本；美股報稅常用 FIFO（先賣最早買進的股份，每個買進批次各記一筆已實現損益）。
          切換只影響之後的賣出，既有紀錄不重算。持倉若缺少完整的買進批次紀錄（例如手動調整過股數），
          FIFO 會自動改用平均成本，並在該筆紀錄標示。
        </p>
      </CardContent>
    </Card>
  );
}
