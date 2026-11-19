import { z } from 'zod';

export const TransactionSchema = z.object({
  type: z.enum(['expense', 'income', 'transfer']),
  amount: z.coerce.number().positive('金額需大於 0'),
  currency: z.string().min(3).max(5).default('TWD'),
  category: z.string().min(1, '請選擇類別'),
  subCategory: z.string().optional(),
  paymentMethod: z.string().default('現金'),
  fromAccountId: z.string().nullable().optional(),
  toAccountId: z.string().nullable().optional(),
  note: z.string().max(200).optional(),
  date: z.date(),
  tripId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
}).superRefine((value, ctx) => {
  if (value.type === 'expense' && !value.fromAccountId && value.paymentMethod.trim() === '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fromAccountId'], message: '支出需選擇付款帳戶或支付方式' });
  }
  if (value.type === 'income' && value.fromAccountId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fromAccountId'], message: '收入不可有來源帳戶' });
  }
  if (value.type === 'transfer') {
    if (!value.fromAccountId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fromAccountId'], message: '轉帳需選擇來源帳戶' });
    }
    if (!value.toAccountId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toAccountId'], message: '轉帳需選擇目標帳戶' });
    }
    if (value.fromAccountId && value.toAccountId && value.fromAccountId === value.toAccountId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toAccountId'], message: '來源與目標帳戶不可相同' });
    }
  }
});
export type TransactionFormInput = z.infer<typeof TransactionSchema>;

export const CategorySchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['expense', 'income']),
  icon: z.string().min(1),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  order: z.number().int().min(0),
  budget: z.number().nonnegative().optional(),
});
export type CategoryFormInput = z.infer<typeof CategorySchema>;

export const BudgetSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  total: z.number().nonnegative(),
  byCategory: z.record(z.string(), z.number().nonnegative()),
});
export type BudgetFormInput = z.infer<typeof BudgetSchema>;
