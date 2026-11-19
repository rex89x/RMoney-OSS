import { z } from 'zod';
import { normalizeJointSymbol } from './calc';

/** 新增持股（含第一筆買進） */
export const JointHoldingFormSchema = z.object({
  symbol: z.string().trim().min(1, '請輸入股票代號').superRefine((v, ctx) => {
    const r = normalizeJointSymbol(v);
    if (!r.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.reason });
  }),
  name: z.string().trim().max(40, '名稱最多 40 字'),
  /** 'joint' 或持有人 uid */
  bucketKey: z.string().min(1, '請選擇誰持有'),
  date: z.date(),
  shares: z.number({ error: '請輸入股數' }).positive('股數要大於 0'),
  price: z.number({ error: '請輸入成交價' }).positive('成交價要大於 0'),
  fee: z.number().min(0, '手續費不能為負').default(0),
  note: z.string().trim().max(200).optional(),
});
export type JointHoldingFormValues = z.infer<typeof JointHoldingFormSchema>;

/** 既有持股加一筆買進 / 賣出 */
export const JointTradeFormSchema = z.object({
  side: z.enum(['buy', 'sell']),
  date: z.date(),
  shares: z.number({ error: '請輸入股數' }).positive('股數要大於 0'),
  price: z.number({ error: '請輸入成交價' }).positive('成交價要大於 0'),
  fee: z.number().min(0, '手續費不能為負').default(0),
});
export type JointTradeFormValues = z.infer<typeof JointTradeFormSchema>;

/** 共同投資計畫 */
export const JointPlanFormSchema = z.object({
  name: z.string().trim().min(1, '請輸入名稱').max(30),
  targetAmountTWD: z.number({ error: '請輸入目標金額' }).positive('目標金額要大於 0'),
  targetDate: z.date().nullable(),
  expectedAnnualReturnPct: z.number({ error: '請輸入年化報酬' }).min(-20).max(30, '年化報酬假設請介於 -20% 到 30%'),
  monthlyContributionTWD: z.record(z.string(), z.number().min(0, '不能為負')),
});
export type JointPlanFormValues = z.infer<typeof JointPlanFormSchema>;
