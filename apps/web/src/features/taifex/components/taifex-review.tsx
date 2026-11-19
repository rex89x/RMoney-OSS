import { useMemo, useState } from 'react';
import {
  Bot, CalendarClock, Check, ClipboardCheck, ClipboardCopy, ExternalLink, GitPullRequest, Lightbulb, RotateCcw, SlidersHorizontal, TriangleAlert, Undo2, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { EmptyState } from '@/components/ui/empty-state';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { formatTW } from '@/lib/tz';
import { cn } from '@/lib/utils';
import { useApplyTaifexReview, useRejectTaifexReview, useRevertTaifexTuning, useTaifexReviews, useTaifexTuning } from '../hooks';
import { VARIANT_LABELS, formatPctValue, formatTWD, pnlClass } from '../options';
import {
  REVIEW_STATUS_LABELS,
  TAIFEX_REVIEW_SCHEDULE,
  TAIFEX_TECH_WEIGHT_KEYS,
  TUNING_SECTION_LABELS,
  buildTaifexReviewPrompt,
  formatTuningValue,
  tuningLabel,
  type TaifexCompareMetrics,
  type TaifexReview as TaifexReviewDoc,
  type TaifexReviewBacktest,
  type TaifexTuning,
} from '../review';
import { TAIFEX_FACTOR_KEYS, type TaifexConfig } from '../types';

interface TaifexReviewProps {
  config: TaifexConfig;
}

/** 週檢討：Claude 每週日存的檢討與調整提案 → 你核准才套用；可還原最近一次套用 */
export function TaifexReview({ config }: TaifexReviewProps) {
  const reviews = useTaifexReviews(true);
  const tuning = useTaifexTuning(true);
  const apply = useApplyTaifexReview();
  const reject = useRejectTaifexReview();
  const revert = useRevertTaifexTuning();
  const confirm = useConfirm();
  const [setupOpen, setSetupOpen] = useState(false);
  const busy = apply.isPending || reject.isPending || revert.isPending;
  const list = reviews.data ?? [];

  async function handleApply(review: TaifexReviewDoc) {
    const lines = review.proposal?.diff.map((d) => `${tuningLabel(d)} ${formatTuningValue(d.from)} → ${formatTuningValue(d.to)}`) ?? [];
    const ok = await confirm({
      title: '套用這份調整？',
      description: `${lines.join('；')}。${review.proposal?.switchVariant ? '主帳戶會切換到「Claude 調校」策略變體。' : ''}下一次每日流程（或盤中下一次取樣）起生效，之後可以還原。`,
      confirmText: '套用',
    });
    if (ok) apply.mutate(review.id);
  }

  async function handleReject(review: TaifexReviewDoc) {
    const ok = await confirm({ title: '退回這份提案？', description: '參數不會變動；檢討內容會保留。', confirmText: '退回' });
    if (ok) reject.mutate(review.id);
  }

  async function handleRevert(reviewId: string) {
    const ok = await confirm({
      title: '還原最近一次套用？',
      description: `調校值、資金管理與策略變體會回到套用 ${reviewId} 那份檢討之前的狀態。`,
      confirmText: '還原',
      variant: 'danger',
    });
    if (ok) revert.mutate(reviewId);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <ClipboardCheck className="size-4" aria-hidden /> 每週檢討
            <Button size="sm" variant="outline" className="ml-auto h-8" onClick={() => setSetupOpen(true)}>
              <CalendarClock className="size-3.5" /> Claude 排程設定
            </Button>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Claude 每週日透過 MCP 讀取這一週的帳戶、訊號、策略競賽與回測，寫下檢討並在必要時提出參數調整。
            提案不會自己生效：你在這裡按「套用」才會寫入，而且每個參數都有寫死的上下限。
          </p>
        </CardHeader>
        <CardContent>
          {tuning.isLoading ? <Skeleton className="h-20 w-full" /> : (
            <TuningSummary tuning={tuning.data ?? null} config={config} busy={busy} onRevert={(id) => void handleRevert(id)} />
          )}
        </CardContent>
      </Card>

      {reviews.isLoading ? <Skeleton className="h-64 w-full" /> : list.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="還沒有週檢討"
          description="設定好 Claude 排程後，每週日晚上會出現一份檢討；有調整提案時會推播 Telegram，回到這裡核准。"
          action={<Button size="sm" onClick={() => setSetupOpen(true)}><CalendarClock className="size-3.5" /> 設定 Claude 排程</Button>}
        />
      ) : list.map((review) => (
        <ReviewCard
          key={review.id}
          review={review}
          busy={busy}
          onApply={() => void handleApply(review)}
          onReject={() => void handleReject(review)}
        />
      ))}

      <ReviewSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
    </div>
  );
}

function TuningSummary({ tuning, config, busy, onRevert }: { tuning: TaifexTuning | null; config: TaifexConfig; busy: boolean; onRevert: (id: string) => void }) {
  const onTuned = config.strategyVariant === 'tuned';
  const untouched = !tuning || (!tuning.params && !tuning.weights && !tuning.tech);
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <SlidersHorizontal className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">目前生效的調校</span>
        <Badge variant={onTuned ? 'success' : 'secondary'}>主帳戶：{VARIANT_LABELS[config.strategyVariant].label}</Badge>
        {tuning && tuning.version > 0 ? <span className="text-muted-foreground">第 {tuning.version} 版{tuning.updatedAt ? ` · ${formatTW(tuning.updatedAt, 'MM/dd HH:mm')}` : ''}</span> : null}
        {tuning?.reviewId ? (
          <Button size="sm" variant="ghost" className="ml-auto h-8" disabled={busy} onClick={() => onRevert(tuning.reviewId ?? '')}>
            <Undo2 className="size-3.5" /> 還原最近一次套用
          </Button>
        ) : null}
      </div>
      {untouched ? (
        <p className="text-xs text-muted-foreground">還沒有套用過任何提案：門檻、因子權重與盤中規則都是程式內建的預設值。</p>
      ) : (
        <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
          <TuningFact label={TUNING_SECTION_LABELS.params}>
            {tuning?.params
              ? `進場 ±${tuning.params.entry}、出場 ${tuning.params.exit}、停損 ${tuning.params.stopAtr}×ATR、移動 ${tuning.params.trailAtr}×ATR、ADX ${tuning.params.adxTrend}、盤整 ×${tuning.params.chopDamp}`
              : '預設'}
          </TuningFact>
          <TuningFact label={TUNING_SECTION_LABELS.weights}>
            {tuning?.weights ? TAIFEX_FACTOR_KEYS.map((k) => `${tuningLabel({ section: 'weights', key: k }).replace('權重：', '')} ${tuning.weights?.[k]}`).join('、') : '預設'}
          </TuningFact>
          <TuningFact label={TUNING_SECTION_LABELS.tech}>
            {tuning?.tech
              ? `進場 ±${tuning.tech.entry}、出場 ${tuning.tech.exit}、停損 ${tuning.tech.stopAtr}×ATR、移動 ${tuning.tech.trailAtr}×ATR；${TAIFEX_TECH_WEIGHT_KEYS.map((k) => `${k} ${tuning.tech?.weights[k]}`).join('、')}`
              : '預設'}
          </TuningFact>
        </dl>
      )}
      {!untouched && !onTuned && (tuning?.params || tuning?.weights) ? (
        <p className="text-[11px] text-muted-foreground">
          主帳戶目前不是「Claude 調校」變體，日線的調校值只會用在策略競賽的「Claude 調校」虛擬帳戶；要讓主帳戶也用，到設定切換策略變體。
        </p>
      ) : null}
    </div>
  );
}

function TuningFact({ label, children }: { label: string; children: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/50 p-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

function ReviewCard({ review, busy, onApply, onReject }: { review: TaifexReviewDoc; busy: boolean; onApply: () => void; onReject: () => void }) {
  const status = REVIEW_STATUS_LABELS[review.status];
  const proposal = review.proposal;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span className="tabular-nums">{review.weekStart ? `${review.weekStart} – ${review.weekEnd}` : review.weekEnd}</span>
          <Badge variant={status.variant}>{status.label}</Badge>
          {review.week ? (
            <span className={cn('ml-auto text-sm font-medium tabular-nums', pnlClass(review.week.pnl))}>
              {formatTWD(review.week.pnl, true)}（{formatPctValue(review.week.pct, 2)}）
            </span>
          ) : null}
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          {review.createdAt ? `檢討於 ${formatTW(review.createdAt, 'MM/dd HH:mm')}` : ''}
          {review.client ? ` · ${review.client}` : ''}
          {review.week && review.week.indexChangePct !== null ? ` · 指數 ${formatPctValue(review.week.indexChangePct, 2)}` : ''}
          {review.decidedAt ? ` · 處理於 ${formatTW(review.decidedAt, 'MM/dd HH:mm')}` : ''}
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="whitespace-pre-wrap break-words">{review.summary}</p>
        {review.findings.length ? (
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {review.findings.map((f) => <li key={f} className="break-words">{f}</li>)}
          </ul>
        ) : null}

        {proposal ? (
          <section className="space-y-3 rounded-xl border p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
              <SlidersHorizontal className="size-3.5" aria-hidden /> 調整提案
              {proposal.sections.map((s) => <Badge key={s} variant="outline" className="px-1.5 py-0 text-[10px]">{TUNING_SECTION_LABELS[s]}</Badge>)}
            </div>
            <div className="min-w-0">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left font-normal">項目</th>
                    <th className="text-right font-normal">目前</th>
                    <th className="text-right font-normal">提案</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {proposal.diff.map((d) => (
                    <tr key={`${d.section}.${d.key}`} className="border-t">
                      <td className="py-1.5 pr-2">{tuningLabel(d)}</td>
                      <td className="whitespace-nowrap pl-2 text-right text-muted-foreground">{formatTuningValue(d.from)}</td>
                      <td className="whitespace-nowrap pl-2 text-right font-medium">{formatTuningValue(d.to)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {proposal.rationale ? <p className="break-words text-xs text-muted-foreground">{proposal.rationale}</p> : null}
            {proposal.backtest ? <BacktestCompare backtest={proposal.backtest} /> : (
              <p className="text-[11px] text-muted-foreground">這份提案沒有回測對照（只動到盤中技術模擬，或日 K 不足）。</p>
            )}
            {proposal.switchVariant && review.status === 'proposed' ? (
              <p className="text-[11px] text-muted-foreground">套用後主帳戶會切換到「Claude 調校」策略變體。</p>
            ) : null}
            {review.status === 'proposed' ? (
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={onReject}><X className="size-3.5" /> 退回</Button>
                <Button size="sm" disabled={busy} onClick={onApply}><Check className="size-3.5" /> 套用</Button>
              </div>
            ) : null}
          </section>
        ) : null}

        {review.algorithmIdeas.length || review.prUrl ? (
          <section className="space-y-2 rounded-xl border p-3 text-xs">
            <div className="flex items-center gap-2 font-medium"><Lightbulb className="size-3.5" aria-hidden /> 演算法調整（要改程式）</div>
            {review.algorithmIdeas.length ? (
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                {review.algorithmIdeas.map((idea) => <li key={idea} className="break-words">{idea}</li>)}
              </ul>
            ) : null}
            {review.prUrl ? (
              <a href={review.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-primary underline-offset-2 hover:underline">
                <GitPullRequest className="size-3.5" aria-hidden /> 查看 Pull Request <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : null}
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BacktestCompare({ backtest }: { backtest: TaifexReviewBacktest }) {
  const rows: Array<{ label: string; current: TaifexCompareMetrics | null; proposed: TaifexCompareMetrics | null }> = [
    { label: `樣本外（${backtest.outOfSampleFrom} 起）`, current: backtest.current.outOfSample, proposed: backtest.proposed.outOfSample },
    { label: `完整期間（${backtest.from} 起）`, current: backtest.current.full, proposed: backtest.proposed.full },
  ];
  const dd = (m: TaifexCompareMetrics | null) => (m?.maxDrawdownPct === null || m?.maxDrawdownPct === undefined ? '—' : `-${m.maxDrawdownPct.toFixed(1)}%`);
  const sharpe = (m: TaifexCompareMetrics | null) => (m?.sharpe === null || m?.sharpe === undefined ? '—' : m.sharpe.toFixed(2));
  return (
    <div className="space-y-2">
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[520px] whitespace-nowrap text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left font-normal">回測對照</th>
              <th className="text-left font-normal" />
              <th className="text-right font-normal">報酬</th>
              <th className="text-right font-normal">最大回撤</th>
              <th className="text-right font-normal">Sharpe</th>
              <th className="text-right font-normal">交易</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.flatMap((row) => [
              <tr key={`${row.label}-cur`} className="border-t">
                <td className="py-1.5" rowSpan={2}>{row.label}</td>
                <td className="text-muted-foreground">目前</td>
                <td className={cn('text-right', pnlClass(row.current?.totalReturnPct))}>{formatPctValue(row.current?.totalReturnPct, 1)}</td>
                <td className="text-right">{dd(row.current)}</td>
                <td className="text-right">{sharpe(row.current)}</td>
                <td className="text-right">{row.current?.trades ?? '—'}</td>
              </tr>,
              <tr key={`${row.label}-new`}>
                <td className="py-1.5 font-medium">提案</td>
                <td className={cn('text-right font-medium', pnlClass(row.proposed?.totalReturnPct))}>{formatPctValue(row.proposed?.totalReturnPct, 1)}</td>
                <td className="text-right">{dd(row.proposed)}</td>
                <td className="text-right">{sharpe(row.proposed)}</td>
                <td className="text-right">{row.proposed?.trades ?? '—'}</td>
              </tr>,
            ])}
          </tbody>
        </table>
      </div>
      {backtest.warnings.map((w) => (
        <p key={w} className="flex items-start gap-1.5 text-[11px] text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> <span className="min-w-0 break-words">{w}</span>
        </p>
      ))}
    </div>
  );
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('已複製提示詞');
  } catch (error) {
    console.error('[copyText]', error);
    toast.error('複製失敗，請手動選取');
  }
}

function ReviewSetupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const prompt = useMemo(() => (open ? buildTaifexReviewPrompt() : ''), [open]);
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Claude 排程：每週檢討"
      description="讓 Claude 每週日檢討台指期模擬的表現，並把調整提案送回來給你核准。"
      contentClassName="sm:max-w-2xl"
    >
      <div className="space-y-4 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li>到「AI 分析 → MCP 連線」確認 Claude 的連線已授權，並開啟「允許寫入」（存檢討需要寫入權限；它只能存提案，改不了參數）。</li>
          <li>在 Claude 建立排程：{TAIFEX_REVIEW_SCHEDULE}，連接 Personal Hub 的 MCP connector，貼上下方提示詞。排在週日 20:00 的回測與最佳化之後。</li>
          <li>想讓它在需要改公式時直接開 Pull Request，排程再加上這個專案的 GitHub repo；沒有 repo 時它只會把想法寫在檢討裡。</li>
          <li>有調整提案時會推播 Telegram；回到「週檢討」分頁看回測對照，按「套用」或「退回」。</li>
        </ol>
        <section className="space-y-3 rounded-xl border p-3">
          <div className="flex items-center gap-2 font-medium"><ClipboardCopy className="size-4" aria-hidden /> 提示詞</div>
          <Textarea readOnly value={prompt} className="h-48 font-mono text-[11px]" />
          <Button type="button" size="sm" variant="outline" onClick={() => void copyText(prompt)}>
            <ClipboardCopy className="size-4" /> 複製提示詞
          </Button>
        </section>
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <RotateCcw className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          可調整的只有四區：日線門檻與停損、日線因子權重、資金管理、盤中技術模擬規則。每一項都有上下限，超出範圍的提案在送出時就會被拒絕；套用後可以還原最近一次。
        </p>
      </div>
    </ResponsiveDialog>
  );
}
