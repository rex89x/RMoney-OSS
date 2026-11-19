import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { useAccounts } from '@/features/accounts';
import { useCategories } from '@/features/ledger/hooks';
import { usePaymentMethods } from '@/features/ledger/payment-methods';
import { useFxRates } from '@/features/fx/hooks';
import { usePortfolio } from '@/features/investments/hooks';
import { callAppsScript } from '@/lib/apps-script';
import { applyImportRows, type ImportResult } from './apply';
import { normalizeImport, patchRow, TRADE_ACCOUNT_TYPES, type ImportRow, type NormalizeContext } from './normalize';
import { buildImportPrompt } from './prompt';
import { parseImportEnvelope, type ParseEnvelopeResult } from './schema';

export interface AiImportState {
  rawText: string;
  setRawText: (v: string) => void;
  jsonText: string;
  setJsonText: (v: string) => void;
  prompt: string;
  convertWithClaude: () => Promise<void>;
  converting: boolean;
  parse: () => Promise<void>;
  parsing: boolean;
  parseError: string | null;
  rejected: ParseEnvelopeResult['rejected'];
  /** 貼進來的不是合法 JSON，自動修好了（引號 / 逗號 / 括號） */
  repaired: boolean;
  /** 內容被截斷（括號沒收完），最後一筆已丟掉 */
  truncated: boolean;
  rows: ImportRow[];
  toggleRow: (key: string, selected: boolean) => void;
  setRowCategory: (key: string, categoryKey: string) => void;
  setRowAccount: (key: string, accountId: string | null) => void;
  setRowPayment: (key: string, payment: { paymentMethod: string; accountId: string | null }) => void;
  apply: () => Promise<void>;
  applying: boolean;
  progress: { done: number; total: number };
  results: ImportResult[] | null;
  reset: () => void;
  ctx: NormalizeContext;
}

/** AI 匯入的整個流程：提示詞 → JSON → 正規化預覽 → 寫入 */
export function useAiImport(): AiImportState {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: categories = [] } = useCategories();
  const { data: accounts = [] } = useAccounts();
  const { data: paymentMethods = [] } = usePaymentMethods();
  const { data: fxRates = [] } = useFxRates();
  const { data: positions = [] } = usePortfolio();

  const ctx = useMemo<NormalizeContext>(() => ({
    categories,
    accounts,
    paymentMethods,
    fxRates,
    positions,
    // 預設交割帳戶：投資現金帳戶優先，其次其他可交割帳戶
    defaultTradeAccountId: (accounts.find((a) => a.active !== false && !a.archivedAt && a.type === 'investment_cash')
      ?? accounts.find((a) => a.active !== false && !a.archivedAt && (TRADE_ACCOUNT_TYPES as readonly string[]).includes(a.type)))?.id ?? null,
  }), [categories, accounts, paymentMethods, fxRates, positions]);

  const prompt = useMemo(() => buildImportPrompt({ categories, accounts, paymentMethods, fenced: true }), [categories, accounts, paymentMethods]);

  const [rawText, setRawText] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [converting, setConverting] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<ParseEnvelopeResult['rejected']>([]);
  const [repaired, setRepaired] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<ImportResult[] | null>(null);

  const convertWithClaude = useCallback(async () => {
    if (!rawText.trim()) { toast.error('先貼上要轉換的內容'); return; }
    setConverting(true);
    try {
      const res = await callAppsScript<{ json?: string }>('parseImport', undefined, { text: rawText });
      const json = (res as { json?: unknown }).json;
      if (!res.ok || typeof json !== 'string') throw new Error(typeof res.error === 'string' ? res.error : '轉換失敗');
      setJsonText(json);
      toast.success('已用 Claude 轉成 JSON，請按「解析預覽」檢查');
    } catch (err) {
      console.error('[aiImportConvert]', err);
      toast.error(err instanceof Error ? err.message : '轉換失敗');
    } finally {
      setConverting(false);
    }
  }, [rawText]);

  const parse = useCallback(async () => {
    setParsing(true);
    setResults(null);
    try {
      const parsed = parseImportEnvelope(jsonText);
      setParseError(parsed.error);
      setRejected(parsed.rejected);
      setRepaired(parsed.repaired);
      setTruncated(parsed.truncated);
      if (!parsed.envelope) { setRows([]); return; }
      setRows(await normalizeImport(parsed.envelope.items, ctx));
    } finally {
      setParsing(false);
    }
  }, [jsonText, ctx]);

  const toggleRow = useCallback((key: string, selected: boolean) => {
    setRows((prev) => prev.map((r) => (r.key === key && r.status !== 'error' ? { ...r, selected } : r)));
  }, []);
  const setRowCategory = useCallback((key: string, categoryKey: string) => {
    setRows((prev) => prev.map((r) => (r.key === key ? patchRow(r, { categoryKey }, ctx) : r)));
  }, [ctx]);
  const setRowAccount = useCallback((key: string, accountId: string | null) => {
    setRows((prev) => prev.map((r) => (r.key === key ? patchRow(r, { accountId }, ctx) : r)));
  }, [ctx]);
  const setRowPayment = useCallback((key: string, payment: { paymentMethod: string; accountId: string | null }) => {
    setRows((prev) => prev.map((r) => {
      if (r.key !== key || r.resolved.kind === 'trade') return r;
      if (r.resolved.paymentMethod === payment.paymentMethod && (r.resolved.accountId ?? null) === payment.accountId) return r;
      return patchRow(r, payment, ctx);
    }));
  }, [ctx]);

  const apply = useCallback(async () => {
    if (!user) return;
    setApplying(true);
    setProgress({ done: 0, total: rows.filter((r) => r.selected && r.status !== 'error').length });
    try {
      const out = await applyImportRows(rows, user.uid, (done, total) => setProgress({ done, total }));
      setResults(out);
      const created = out.filter((r) => r.outcome === 'created').length;
      const skipped = out.filter((r) => r.outcome === 'skipped').length;
      const failed = out.filter((r) => r.outcome === 'failed').length;
      toast[failed > 0 ? 'warning' : 'success'](`匯入 ${created} 筆${skipped ? `，略過 ${skipped} 筆已存在` : ''}${failed ? `，${failed} 筆失敗` : ''}`);
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
      void qc.invalidateQueries({ queryKey: ['realized-lots'] });
      void qc.invalidateQueries({ queryKey: ['stocks'] });
    } catch (err) {
      console.error('[aiImportApply]', err);
      toast.error(err instanceof Error ? err.message : '匯入失敗');
    } finally {
      setApplying(false);
    }
  }, [rows, user, qc]);

  const reset = useCallback(() => {
    setRawText('');
    setJsonText('');
    setRows([]);
    setRejected([]);
    setRepaired(false);
    setTruncated(false);
    setParseError(null);
    setResults(null);
    setProgress({ done: 0, total: 0 });
  }, []);

  return {
    rawText, setRawText, jsonText, setJsonText, prompt,
    convertWithClaude, converting, parse, parsing, parseError, rejected, repaired, truncated,
    rows, toggleRow, setRowCategory, setRowAccount, setRowPayment,
    apply, applying, progress, results, reset, ctx,
  };
}
