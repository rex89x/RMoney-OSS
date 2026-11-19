import { useState } from 'react';
import { Coins, Loader2 } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { useTrips } from '@/features/trips';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useAnalysisFlow } from '../hooks';
import { defaultReviewMonth, recentTWMonths } from '../months';
import { ANALYSIS_FOCUS_MAX } from '../schema';
import type { AnalysisDefinition, AnalysisRequest } from '../types';
import { AnalysisConfirmDialog } from './analysis-confirm-dialog';
import { AnalysisResultView } from './analysis-result-view';

const AUTO_TRIP = '__auto__';

interface AnalysisCardProps {
  definition: AnalysisDefinition;
}

export function AnalysisCard({ definition }: AnalysisCardProps) {
  const flow = useAnalysisFlow(definition.kind);
  const [month, setMonth] = useState(defaultReviewMonth);
  const months = recentTWMonths(12);
  const Icon = definition.icon;
  const busy = flow.estimating || flow.running;
  const [tripId, setTripId] = useState(AUTO_TRIP);
  const [focus, setFocus] = useState('');
  const trips = useTrips();
  const tripOptions = definition.needsTrip ? (trips.data ?? []).filter((t) => t.status !== 'done') : [];
  const request: AnalysisRequest = {
    kind: definition.kind,
    ...(definition.needsMonth ? { month } : {}),
    ...(definition.needsTrip && tripId !== AUTO_TRIP ? { tripId } : {}),
    ...(focus.trim() ? { focus: focus.trim() } : {}),
  };

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-5 shrink-0" /> {definition.title}
        </CardTitle>
        <CardDescription>{definition.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {definition.needsMonth ? (
            <Select value={month} onValueChange={setMonth} disabled={busy}>
              <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                {months.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}
          {definition.needsTrip ? (
            <Select value={tripId} onValueChange={setTripId} disabled={busy}>
              <SelectTrigger className="h-9 w-48 min-w-0"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_TRIP}>讓 Claude 自己挑</SelectItem>
                {tripOptions.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}
          <Button onClick={() => void flow.requestEstimate(request)} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Coins className="size-4" />}
            {flow.estimating ? '估算費用中…' : flow.running ? 'Claude 分析中…' : '估算費用並執行'}
          </Button>
        </div>
        <Textarea
          value={focus}
          onChange={(e) => setFocus(e.target.value.slice(0, ANALYSIS_FOCUS_MAX))}
          disabled={busy}
          rows={2}
          placeholder="想特別關注的重點（選填），例如：最近外食是不是變多了"
          className="min-h-0 text-sm"
        />
        {flow.running ? (
          <p className="text-xs text-muted-foreground">Claude 正在自己查資料並撰寫報告，通常需要 1–3 分鐘，請不要關閉頁面。</p>
        ) : null}
        {flow.result ? <AnalysisResultView result={flow.result} /> : null}
      </CardContent>
      <AnalysisConfirmDialog
        definition={definition}
        estimate={flow.pending?.estimate ?? null}
        month={flow.pending?.request.month}
        onConfirm={() => void flow.confirm()}
        onCancel={flow.cancel}
      />
    </Card>
  );
}
