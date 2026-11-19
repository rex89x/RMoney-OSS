/**
 * 再平衡計算：把「配置目標 vs 實際」的差額換算成每檔要買 / 賣幾股。
 *
 * 口徑：
 *   - 總額 = 投資市值 + （目標含 cash 時）現金類帳戶餘額 + 額外投入
 *   - 每個目標 key 的差額 = 目標金額 − 實際金額
 *   - 市場（TW / US）的差額依「目前各檔在該市場的權重」分配到各檔；市場內沒持倉時無法分配（顯示金額即可）
 *   - 只買不賣模式：忽略正超配的賣出，只用額外投入補低配（依缺口比例）
 */
import type { AllocationTarget } from '@/types/global';
import type { PortfolioSnapshot, PortfolioSnapshotPosition } from './types';

export interface RebalanceLine {
  symbol: string;
  market: 'TW' | 'US';
  currentPrice: number;
  fxRate: number;
  /** 正 = 買、負 = 賣（股數，整數） */
  shares: number;
  /** 對應 TWD 金額（正買負賣） */
  amountTWD: number;
  currentValueTWD: number;
}

export interface RebalanceGroup {
  key: string;
  label: string;
  targetPct: number;
  actualPct: number;
  targetTWD: number;
  actualTWD: number;
  /** 正 = 要加碼、負 = 超配 */
  deltaTWD: number;
  lines: RebalanceLine[];
  /** 無法拆到個股的部分（沒持倉的市場 / cash / 自訂） */
  unallocatedTWD: number;
}

export interface RebalancePlan {
  totalTWD: number;
  contributionTWD: number;
  groups: RebalanceGroup[];
  buyTotalTWD: number;
  sellTotalTWD: number;
}

export interface RebalanceInput {
  snapshot: PortfolioSnapshot;
  targets: AllocationTarget[];
  cashTWD: number;
  contributionTWD: number;
  sellAllowed: boolean;
}

function marketOf(t: AllocationTarget): 'TW' | 'US' | null {
  return t.key === 'TW' || t.key === 'US' ? t.key : null;
}

export function computeRebalance(input: RebalanceInput): RebalancePlan {
  const { snapshot, targets, cashTWD, contributionTWD, sellAllowed } = input;
  const includesCash = targets.some((t) => t.key === 'cash');
  const investTWD = snapshot.totalValueTWD;
  const totalTWD = investTWD + (includesCash ? cashTWD : 0) + Math.max(0, contributionTWD);
  const positionsByMarket: Record<'TW' | 'US', PortfolioSnapshotPosition[]> = { TW: [], US: [] };
  for (const p of snapshot.positions) {
    if (p.market === 'TW' || p.market === 'US') positionsByMarket[p.market].push(p);
  }

  const raw = targets.map((t) => {
    const m = marketOf(t);
    const actualTWD = m
      ? snapshot.byMarket[m]?.valueTWD ?? 0
      : t.key === 'cash'
        ? cashTWD + Math.max(0, contributionTWD)
        : 0;
    const targetTWD = (t.pct / 100) * totalTWD;
    return { t, m, actualTWD, targetTWD, delta: targetTWD - actualTWD };
  });

  // 只買不賣：把額外投入依缺口比例分給低配的，超配的差額歸零
  let deltas = raw.map((r) => r.delta);
  if (!sellAllowed) {
    const gaps = raw.map((r) => Math.max(0, r.delta));
    const gapSum = gaps.reduce((s, g) => s + g, 0);
    const budget = Math.max(0, contributionTWD);
    deltas = gaps.map((g) => (gapSum > 0 ? Math.min(g, (g / gapSum) * budget) : 0));
  }

  let buyTotalTWD = 0;
  let sellTotalTWD = 0;
  const groups: RebalanceGroup[] = raw.map((r, i) => {
    const delta = deltas[i] ?? 0;
    const lines: RebalanceLine[] = [];
    let allocated = 0;
    if (r.m && Math.abs(delta) >= 1) {
      const positions = positionsByMarket[r.m];
      const marketValue = positions.reduce((s, p) => s + p.valueTWD, 0);
      for (const p of positions) {
        const weight = marketValue > 0 ? p.valueTWD / marketValue : 1 / Math.max(1, positions.length);
        const priceTWD = p.currentPrice * (p.fxRate || 1);
        if (priceTWD <= 0) continue;
        const targetAmount = delta * weight;
        const shares = targetAmount >= 0 ? Math.floor(targetAmount / priceTWD) : -Math.floor(-targetAmount / priceTWD);
        if (shares === 0) continue;
        // 不能賣超過持有
        const clamped = shares < 0 ? Math.max(shares, -Math.floor(p.shares)) : shares;
        const amountTWD = clamped * priceTWD;
        allocated += amountTWD;
        lines.push({
          symbol: p.symbol,
          market: r.m,
          currentPrice: p.currentPrice,
          fxRate: p.fxRate || 1,
          shares: clamped,
          amountTWD,
          currentValueTWD: p.valueTWD,
        });
      }
    }
    lines.sort((a, b) => Math.abs(b.amountTWD) - Math.abs(a.amountTWD));
    for (const l of lines) {
      if (l.amountTWD > 0) buyTotalTWD += l.amountTWD; else sellTotalTWD += -l.amountTWD;
    }
    return {
      key: r.t.key,
      label: r.t.label,
      targetPct: r.t.pct,
      actualPct: totalTWD > 0 ? (r.actualTWD / totalTWD) * 100 : 0,
      targetTWD: r.targetTWD,
      actualTWD: r.actualTWD,
      deltaTWD: delta,
      lines,
      unallocatedTWD: delta - allocated,
    };
  });

  return { totalTWD, contributionTWD, groups, buyTotalTWD, sellTotalTWD };
}
