/**
 * 支付方式的純型別與標籤（不碰 Firebase），給 import / normalize 等不該拉進 firebase 的模組用。
 * Firestore 讀寫與 hooks 在 `payment-methods.ts`。
 */
export type PaymentMethodType = 'cash' | 'credit' | 'debit' | 'mobile' | 'other';

export interface PaymentMethod {
  id: string;
  key: string;
  name: string;
  type: PaymentMethodType;
  bank?: string;
  last4?: string;
  color?: string;
  icon?: string;
  order?: number;
  archivedAt?: Date | null;
  /** 帳單提醒：開啟後排程會在繳款日當天起每日提醒，直到使用者標記已繳費 */
  billingEnabled?: boolean;
  /** 結帳日（1–31）；超過該月天數會 clamp 至月底 */
  statementDay?: number | null;
  /** 繳款截止日（1–31）；超過該月天數會 clamp 至月底 */
  dueDay?: number | null;
}

export const TYPE_LABEL: Record<PaymentMethodType, string> = {
  cash: '現金',
  credit: '信用卡',
  debit: '簽帳金融',
  mobile: '行動支付',
  other: '其他',
};

export function paymentMethodLabel(p: PaymentMethod): string {
  if (p.type === 'credit' && p.last4) return `${p.name} (****${p.last4})`;
  return p.name;
}
