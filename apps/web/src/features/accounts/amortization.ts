/**
 * 貸款攤還表（F3）— 純函式，無 Firestore / React 依賴（apps/web/tests/amortization.test.cjs）。
 *
 * - 本息平均攤還（annuity）：每期付款固定 = P·r / (1 − (1 + r)^−n)，r = 年利率 / 12
 * - 本金平均攤還（equal_principal）：每期本金固定 = P / n，利息隨剩餘本金遞減
 * - 期數與月付金額擇一：給期數就算月付；只給月付（本息平均）就反推期數，最後一期付清剩餘
 * - 金額四捨五入到 0.01；每期利息 = round2(剩餘本金 × r)，最後一期把剩餘本金全部還清（吸收尾差）
 * - 第 k 期日期 = addTWCalendarMonths(第 1 期日, k − 1)：一律從第 1 期推算，1/31 → 2/28 → 3/31（pitfall #23）
 * - 提前還款試算：第 k 期正常繳款後再多還一筆本金，可選「縮短期數」（月付不變）或「降低月付」（期數不變）
 */
import { addTWCalendarMonths } from '@/lib/tz';

export type AmortizationMethod = 'annuity' | 'equal_principal';
export type EarlyRepaymentMode = 'shorten_term' | 'reduce_payment';

export const AMORTIZATION_METHOD_LABEL: Record<AmortizationMethod, string> = {
  annuity: '本息平均攤還',
  equal_principal: '本金平均攤還',
};

export const EARLY_REPAYMENT_MODE_LABEL: Record<EarlyRepaymentMode, string> = {
  shorten_term: '縮短期數（月付不變）',
  reduce_payment: '降低月付（期數不變）',
};

/** 防呆：最多算 100 年，避免月付太低時無限迴圈 */
export const MAX_AMORTIZATION_MONTHS = 1200;

export interface AmortizationInput {
  principal: number;
  /** 年利率（%），例如 2.06 */
  annualRatePct: number;
  /** 期數（月）；與 monthlyPayment 擇一，兩者都有時以期數為準 */
  termMonths?: number | null;
  /** 每月付款（本息平均攤還時可只給這個，反推期數） */
  monthlyPayment?: number | null;
  /** 第 1 期繳款日 */
  startDate: Date;
  method?: AmortizationMethod;
}

export interface AmortizationRow {
  period: number;
  date: Date;
  payment: number;
  interest: number;
  principal: number;
  /** 該期額外提前還款的本金（只有試算才會出現） */
  extra: number;
  remaining: number;
}

export interface AmortizationSchedule {
  method: AmortizationMethod;
  principal: number;
  annualRatePct: number;
  rows: AmortizationRow[];
  /** 實際期數（= rows.length） */
  termMonths: number;
  /** 第 1 期付款 */
  firstPayment: number;
  /** 最後一期付款 */
  lastPayment: number;
  totalPayment: number;
  totalInterest: number;
  payoffDate: Date | null;
  /** 輸入無法產生攤還表時的原因（rows 為空） */
  error: string | null;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function monthlyRate(annualRatePct: number): number {
  return Math.max(0, Number(annualRatePct) || 0) / 100 / 12;
}

/** 本息平均攤還的每月付款 */
export function annuityPayment(principal: number, annualRatePct: number, termMonths: number): number {
  const n = Math.round(termMonths);
  if (!(principal > 0) || !(n > 0)) return 0;
  const r = monthlyRate(annualRatePct);
  if (r === 0) return round2(principal / n);
  return round2((principal * r) / (1 - Math.pow(1 + r, -n)));
}

/** 月付金額反推期數（本息平均）；月付不足以支付利息時回傳 null */
export function termForPayment(principal: number, annualRatePct: number, payment: number): number | null {
  if (!(principal > 0) || !(payment > 0)) return null;
  const r = monthlyRate(annualRatePct);
  if (r === 0) return Math.ceil(principal / payment - 1e-9);
  if (payment <= round2(principal * r)) return null;
  const n = -Math.log(1 - (r * principal) / payment) / Math.log(1 + r);
  // 月付已四捨五入到分，n 會比整數多一點點（例如 240.0003）；容許 0.001 期的誤差，尾差由最後一期吸收
  return Math.ceil(n - 1e-3);
}

interface ScheduleConfig {
  method: AmortizationMethod;
  principal: number;
  annualRatePct: number;
  startDate: Date;
  /** 固定期數（annuity 由期數算月付時、equal_principal 必填）；null = 依月付跑到還清 */
  termMonths: number | null;
  /** annuity 的固定月付 */
  payment: number;
  extra?: { period: number; amount: number; mode: EarlyRepaymentMode } | null;
}

function emptySchedule(input: Pick<ScheduleConfig, 'method' | 'principal' | 'annualRatePct'>, error: string): AmortizationSchedule {
  return {
    method: input.method,
    principal: input.principal,
    annualRatePct: input.annualRatePct,
    rows: [],
    termMonths: 0,
    firstPayment: 0,
    lastPayment: 0,
    totalPayment: 0,
    totalInterest: 0,
    payoffDate: null,
    error,
  };
}

function runSchedule(cfg: ScheduleConfig): AmortizationSchedule {
  const r = monthlyRate(cfg.annualRatePct);
  const rows: AmortizationRow[] = [];
  let remaining = round2(cfg.principal);
  let payment = cfg.payment;
  let basePrincipal = cfg.termMonths ? round2(cfg.principal / cfg.termMonths) : 0;

  for (let period = 1; remaining > 0 && period <= MAX_AMORTIZATION_MONTHS; period++) {
    const interest = round2(remaining * r);
    let principalPart: number;
    const isFixedLast = cfg.termMonths !== null && period >= cfg.termMonths;
    if (cfg.method === 'equal_principal') {
      principalPart = isFixedLast || basePrincipal >= remaining ? remaining : basePrincipal;
    } else {
      principalPart = round2(payment - interest);
      if (principalPart <= 0) {
        return emptySchedule(cfg, '每期還款不足以支付利息，永遠還不完');
      }
      // 依月付跑到還清時，剩不到 1 元（月付四捨五入累積的尾差）就併進這一期，不另外多一期
      const tolerance = cfg.termMonths === null ? 1 : 0;
      if (isFixedLast || principalPart >= remaining - tolerance) principalPart = remaining;
    }
    remaining = round2(remaining - principalPart);

    let extra = 0;
    if (cfg.extra && cfg.extra.period === period && remaining > 0 && cfg.extra.amount > 0) {
      extra = round2(Math.min(cfg.extra.amount, remaining));
      remaining = round2(remaining - extra);
      if (cfg.extra.mode === 'reduce_payment' && remaining > 0 && cfg.termMonths !== null) {
        const left = cfg.termMonths - period;
        if (left > 0) {
          if (cfg.method === 'annuity') payment = annuityPayment(remaining, cfg.annualRatePct, left);
          else basePrincipal = round2(remaining / left);
        }
      }
    }

    rows.push({
      period,
      date: addTWCalendarMonths(cfg.startDate, period - 1),
      payment: round2(principalPart + interest),
      interest,
      principal: principalPart,
      extra,
      remaining,
    });
  }

  if (remaining > 0) return emptySchedule(cfg, `超過 ${MAX_AMORTIZATION_MONTHS} 期仍未還清，請調高月付`);

  let totalPayment = 0;
  let totalInterest = 0;
  for (const row of rows) {
    totalPayment += row.payment + row.extra;
    totalInterest += row.interest;
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    method: cfg.method,
    principal: round2(cfg.principal),
    annualRatePct: cfg.annualRatePct,
    rows,
    termMonths: rows.length,
    firstPayment: first?.payment ?? 0,
    lastPayment: last?.payment ?? 0,
    totalPayment: round2(totalPayment),
    totalInterest: round2(totalInterest),
    payoffDate: last?.date ?? null,
    error: null,
  };
}

function resolveConfig(input: AmortizationInput): ScheduleConfig | { error: string } {
  const method = input.method ?? 'annuity';
  const principal = Number(input.principal) || 0;
  const annualRatePct = Math.max(0, Number(input.annualRatePct) || 0);
  if (!(principal > 0)) return { error: '本金需大於 0' };
  const term = input.termMonths != null && input.termMonths > 0 ? Math.round(input.termMonths) : null;
  if (term !== null && term > MAX_AMORTIZATION_MONTHS) return { error: `期數最多 ${MAX_AMORTIZATION_MONTHS} 期` };
  if (method === 'equal_principal') {
    if (term === null) return { error: '本金平均攤還需要輸入期數' };
    return { method, principal, annualRatePct, startDate: input.startDate, termMonths: term, payment: 0 };
  }
  if (term !== null) {
    return {
      method, principal, annualRatePct, startDate: input.startDate,
      termMonths: term, payment: annuityPayment(principal, annualRatePct, term),
    };
  }
  const payment = Number(input.monthlyPayment) || 0;
  if (!(payment > 0)) return { error: '請輸入期數或每月還款金額' };
  return { method, principal, annualRatePct, startDate: input.startDate, termMonths: null, payment: round2(payment) };
}

export function buildAmortizationSchedule(input: AmortizationInput): AmortizationSchedule {
  const cfg = resolveConfig(input);
  if ('error' in cfg) {
    return emptySchedule({ method: input.method ?? 'annuity', principal: input.principal, annualRatePct: input.annualRatePct }, cfg.error);
  }
  return runSchedule(cfg);
}

/** 某日當下（含當天已繳那期）的剩餘本金；第 1 期之前 = 本金 */
export function remainingPrincipalAt(schedule: AmortizationSchedule, at: Date): number {
  let remaining = schedule.principal;
  for (const row of schedule.rows) {
    if (row.date.getTime() > at.getTime()) break;
    remaining = row.remaining;
  }
  return remaining;
}

export interface EarlyRepaymentInput extends AmortizationInput {
  /** 第幾期繳完後提前還款（1 起算） */
  atPeriod: number;
  extraAmount: number;
  mode: EarlyRepaymentMode;
}

export interface EarlyRepaymentResult {
  base: AmortizationSchedule;
  after: AmortizationSchedule;
  interestSaved: number;
  monthsSaved: number;
  /** 提前還款後下一期的付款 */
  newPayment: number;
  error: string | null;
}

export function simulateEarlyRepayment(input: EarlyRepaymentInput): EarlyRepaymentResult {
  const base = buildAmortizationSchedule(input);
  const fail = (error: string): EarlyRepaymentResult => ({
    base, after: base, interestSaved: 0, monthsSaved: 0, newPayment: base.firstPayment, error,
  });
  if (base.error) return fail(base.error);
  const k = Math.round(input.atPeriod);
  if (!(k >= 1) || k >= base.termMonths) return fail(`提前還款期數需介於 1 ~ ${Math.max(1, base.termMonths - 1)}`);
  if (!(input.extraAmount > 0)) return fail('提前還款金額需大於 0');
  const cfg = resolveConfig(input);
  if ('error' in cfg) return fail(cfg.error);
  // 只給月付（期數由月付反推）時，「降低月付」以原本反推出來的期數為準
  const termMonths = cfg.termMonths ?? base.termMonths;
  const after = runSchedule({
    ...cfg,
    termMonths: input.mode === 'reduce_payment' ? termMonths : cfg.termMonths,
    extra: { period: k, amount: input.extraAmount, mode: input.mode },
  });
  if (after.error) return fail(after.error);
  const nextRow = after.rows[k];
  return {
    base,
    after,
    interestSaved: round2(base.totalInterest - after.totalInterest),
    monthsSaved: base.termMonths - after.termMonths,
    newPayment: nextRow?.payment ?? 0,
    error: null,
  };
}

/** 圖表用：等距抽樣到最多 maxPoints 點（永遠保留第一期與最後一期，pitfall #13） */
export function downsampleRows<T>(rows: readonly T[], maxPoints = 500): T[] {
  if (rows.length <= maxPoints) return rows.slice();
  const step = Math.ceil(rows.length / maxPoints);
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += step) {
    const row = rows[i];
    if (row !== undefined) out.push(row);
  }
  const last = rows[rows.length - 1];
  if (last !== undefined && out[out.length - 1] !== last) out.push(last);
  return out;
}
