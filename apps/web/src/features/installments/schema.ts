import { z } from 'zod';

/** 新增分期表單（Zod 為表單驗證 single source of truth） */
export const InstallmentPlanFormSchema = z.object({
  title: z.string().trim().min(1, '請輸入品名').max(60, '品名最多 60 字'),
  totalAmountTWD: z.coerce.number().int('請輸入整數金額').positive('金額需大於 0'),
  periods: z.coerce.number().int('期數需為整數').min(2, '至少 2 期').max(120, '最多 120 期'),
  feeTWD: z.coerce.number().int('請輸入整數金額').min(0, '手續費不可為負'),
  cardAccountId: z.string().min(1, '請選擇信用卡帳戶'),
  category: z.string().min(1, '請選擇類別'),
  startDate: z.date({ error: '請選擇首期日期' }),
  note: z.string().max(200, '備註最多 200 字').optional(),
});

/** 驗證後（coerce 完）的值 */
export type InstallmentPlanFormValues = z.infer<typeof InstallmentPlanFormSchema>;
/** 表單欄位的輸入值（zod 4 的 z.coerce 輸入型別是 unknown，useForm 要分開 input / output） */
export type InstallmentPlanFormInput = z.input<typeof InstallmentPlanFormSchema>;
