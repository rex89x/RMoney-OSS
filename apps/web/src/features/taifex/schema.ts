import { z } from 'zod';

/** 資金管理設定；範圍與 GAS tfNormalizeConfig_ 一致（GAS 端會再驗一次） */
export const TaifexConfigSchema = z.object({
  mode: z.enum(['auto', 'manual']),
  product: z.enum(['TX', 'MTX', 'TMF']),
  initialCapital: z.coerce.number().min(50_000, '至少 50,000').max(100_000_000, '最多 1 億'),
  riskPerTradePct: z.coerce.number().min(0.1, '至少 0.1%').max(5, '最多 5%'),
  maxContracts: z.coerce.number().int('需為整數').min(1, '至少 1 口').max(50, '最多 50 口'),
  allowShort: z.boolean(),
  maxDrawdownPct: z.coerce.number().min(5, '至少 5%').max(60, '最多 60%'),
  commissionPerSide: z.coerce.number().min(0).max(1000),
  slippagePoints: z.coerce.number().min(0).max(50),
  marginPerContract: z.coerce.number().min(1000).max(5_000_000),
  notifyEnabled: z.boolean(),
  strategyVariant: z.enum(['baseline', 'conservative', 'aggressive', 'optimized', 'tuned']),
  intradayEnabled: z.boolean(),
  tech: z.object({
    enabled: z.boolean(),
    day: z.boolean(),
    night: z.boolean(),
    notify: z.boolean(),
    contracts: z.coerce.number().int('需為整數').min(1, '至少 1 口').max(20, '最多 20 口'),
    extraHolidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式需為 yyyy-MM-dd')).max(40, '最多 40 筆'),
  }),
});

export type TaifexConfigInput = z.infer<typeof TaifexConfigSchema>;

export const TaifexOrderSchema = z.object({
  target: z.enum(['long', 'short', 'flat']),
  contracts: z.coerce.number().int().min(0).max(50),
  note: z.string().max(100).optional(),
}).refine((v) => v.target === 'flat' || v.contracts >= 1, { message: '至少 1 口', path: ['contracts'] });

export type TaifexOrderInput = z.infer<typeof TaifexOrderSchema>;

/** react-hook-form 的欄位型別（coerce 前） */
export type TaifexConfigFormValues = z.input<typeof TaifexConfigSchema>;
export type TaifexOrderFormValues = z.input<typeof TaifexOrderSchema>;
