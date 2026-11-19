/**
 * 台灣個人投資稅務試算（純計算，數字以稅務憑單為準）。
 *
 * - 二代健保補充保費：單筆股利 ≥ NHI_THRESHOLD_TWD 時，全額 × NHI_RATE
 * - 台股股利兩制擇一：
 *     A 合併計稅：股利併入綜所稅，可抵減 8.5%，抵減上限 80,000
 *     B 分離課稅：股利 × 28%
 * - 海外所得（美股股利 + 美股已實現利得）：
 *     ≥ 1,000,000 須申報基本所得額；基本所得額免稅額 7,500,000（113 年度起）
 */
import type { Dividend, RealizedLot } from './types';

export const NHI_THRESHOLD_TWD = 20000;
export const NHI_RATE = 0.0211;
export const DIVIDEND_CREDIT_RATE = 0.085;
export const DIVIDEND_CREDIT_CAP = 80000;
export const DIVIDEND_SEPARATE_RATE = 0.28;
export const OVERSEAS_REPORT_THRESHOLD = 1000000;
export const AMT_EXEMPTION = 7500000;

export interface DividendTaxEstimate {
  year: number;
  twDividendTWD: number;
  twDividendCount: number;
  nhiSupplementTWD: number;
  nhiHitCount: number;
  creditIfCombinedTWD: number;
  taxIfSeparateTWD: number;
  usDividendTWD: number;
  usRealizedGainTWD: number;
  overseasIncomeTWD: number;
  mustReportOverseas: boolean;
  nearAmt: boolean;
}

function yearOf(d: Date): number {
  // 以台北年份判定；payDate 通常是台北中午或 00:00，這裡用 UTC+8 偏移避免跨年
  return new Date(d.getTime() + 8 * 3600000).getUTCFullYear();
}

export function estimateDividendTax(year: number, dividends: Dividend[], lots: RealizedLot[]): DividendTaxEstimate {
  let twDividendTWD = 0;
  let twDividendCount = 0;
  let nhiSupplementTWD = 0;
  let nhiHitCount = 0;
  let usDividendTWD = 0;
  for (const d of dividends) {
    if (yearOf(d.payDate) !== year) continue;
    if (d.market === 'US' || d.currency === 'USD') { usDividendTWD += d.amountTWD; continue; }
    twDividendTWD += d.amountTWD;
    twDividendCount += 1;
    if (d.amountTWD >= NHI_THRESHOLD_TWD) { nhiSupplementTWD += d.amountTWD * NHI_RATE; nhiHitCount += 1; }
  }
  let usRealizedGainTWD = 0;
  for (const l of lots) {
    if (yearOf(l.sellDate) !== year) continue;
    if (l.market === 'US' || l.currency === 'USD') usRealizedGainTWD += l.realizedPnlTWD;
  }
  const overseasIncomeTWD = usDividendTWD + Math.max(0, usRealizedGainTWD);
  return {
    year,
    twDividendTWD,
    twDividendCount,
    nhiSupplementTWD,
    nhiHitCount,
    creditIfCombinedTWD: Math.min(twDividendTWD * DIVIDEND_CREDIT_RATE, DIVIDEND_CREDIT_CAP),
    taxIfSeparateTWD: twDividendTWD * DIVIDEND_SEPARATE_RATE,
    usDividendTWD,
    usRealizedGainTWD,
    overseasIncomeTWD,
    mustReportOverseas: overseasIncomeTWD >= OVERSEAS_REPORT_THRESHOLD,
    nearAmt: overseasIncomeTWD >= AMT_EXEMPTION,
  };
}
