import { z } from 'zod';

/** 行李項目表單（新增 / 編輯） */
export const PackingItemFormSchema = z.object({
  name: z.string().trim().min(1, '請輸入名稱').max(80, '名稱最多 80 字'),
  category: z.enum(['documents', 'clothes', 'toiletries', 'electronics', 'health', 'other']),
  quantity: z.coerce.number().int('數量需為整數').min(1, '數量至少 1').max(99, '數量最多 99'),
  assignee: z.string().min(1).nullable(),
});

export type PackingItemForm = z.infer<typeof PackingItemFormSchema>;
