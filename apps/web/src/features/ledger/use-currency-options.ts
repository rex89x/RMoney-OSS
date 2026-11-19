import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/use-auth';
import { listFxRates } from '@/features/fx/api';
import type { Currency } from '@/types/global';
import { TX_CURRENCIES } from './types';

/**
 * 記帳表單可選的幣別：預設五種 ∪ owner 追蹤中的匯率（fx_rates）∪ 呼叫端額外指定（例如旅程的外幣、這筆原本的幣別）。
 * `fx_rates` 的 list 只有 owner 能讀，member 只拿預設 + 額外指定的。TWD 永遠排第一。
 */
export function useCurrencyOptions(extra: ReadonlyArray<Currency | null | undefined> = []): Currency[] {
  const { isOwner } = useAuth();
  const { data: rates = [] } = useQuery({
    queryKey: ['fx-rates'],
    queryFn: listFxRates,
    staleTime: 5 * 60 * 1000,
    enabled: isOwner,
  });
  const extraKey = extra.filter(Boolean).join(',');
  const ratesKey = rates.map((r) => r.base).join(',');
  return useMemo(() => {
    const out: Currency[] = ['TWD'];
    const push = (c: Currency | null | undefined) => {
      if (!c) return;
      const code = c.toUpperCase();
      if (!out.includes(code)) out.push(code);
    };
    TX_CURRENCIES.forEach(push);
    ratesKey.split(',').forEach((c) => push(c || null));
    extraKey.split(',').forEach((c) => push(c || null));
    return out;
  }, [ratesKey, extraKey]);
}
