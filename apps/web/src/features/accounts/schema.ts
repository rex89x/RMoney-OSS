import { z } from 'zod';

const optionalNonNegative = z.coerce.number().nonnegative().optional();

export const InsuranceDetailsSchema = z.object({
  insurer: z.string().trim().min(1, '請輸入保險公司'),
  policyNo: z.string().trim().max(64).optional(),
  kind: z.enum(['life', 'health', 'accident', 'property', 'savings', 'other']),
  premiumTWD: z.coerce.number().nonnegative('保費不可小於 0'),
  premiumFrequency: z.enum(['monthly', 'quarterly', 'semiannual', 'annual']),
  nextPremiumDate: z.date({ error: '請選擇下次繳費日' }),
  maturityDate: z.date().optional(),
  coverageTWD: optionalNonNegative,
  cashValueTWD: optionalNonNegative,
});

export const PensionDetailsSchema = z.object({
  provider: z.string().trim().min(1, '請輸入管理機構（例：勞保局）'),
  employerContributionPct: z.coerce.number().min(0).max(100, '提繳率需介於 0–100%').optional(),
  selfContributionPct: z.coerce.number().min(0).max(100, '提繳率需介於 0–100%').optional(),
  monthlySalaryTWD: optionalNonNegative,
  expectedReturnPct: z.coerce.number().min(-50).max(100, '預期報酬需介於 -50% 到 100%').optional(),
  retirementAge: z.coerce.number().int().min(30).max(100, '退休年齡需介於 30–100').optional(),
  birthYear: z.coerce.number().int().min(1900).max(2100, '出生年不合理').optional(),
});

export const AccountSchema = z.object({
  ownerId: z.string().min(1),
  name: z.string().trim().min(1, '請輸入帳戶名稱'),
  type: z.enum(['cash', 'bank', 'credit_card', 'e_wallet_balance', 'investment_cash', 'loan', 'insurance', 'pension']),
  currency: z.string().min(3).max(8).default('TWD'),
  active: z.boolean().default(true),
  archivedAt: z.date().nullable().optional(),
  iconKey: z.string().optional(),
  colorKey: z.string().optional(),
  note: z.string().max(500).optional(),
  balance: z.coerce.number().default(0),
  balanceTWD: z.coerce.number().default(0),
  creditCard: z.object({
    closingDay: z.coerce.number().int().min(1).max(31),
    dueDay: z.coerce.number().int().min(1).max(31),
    cardLast4: z.string().regex(/^\d{4}$/).optional(),
    creditLimit: z.coerce.number().positive().optional(),
    linkedSettlementAccountId: z.string().optional(),
  }).optional(),
  loan: z.object({
    principalTWD: z.coerce.number().nonnegative(),
    interestRate: z.coerce.number().nonnegative().optional(),
    monthlyPayment: z.coerce.number().positive(),
    nextDueDate: z.date(),
    termMonths: z.coerce.number().int().positive().optional(),
    linkedSettlementAccountId: z.string().optional(),
  }).optional(),
  insurance: InsuranceDetailsSchema.optional(),
  pension: PensionDetailsSchema.optional(),
});

export type AccountFormInput = z.infer<typeof AccountSchema>;
