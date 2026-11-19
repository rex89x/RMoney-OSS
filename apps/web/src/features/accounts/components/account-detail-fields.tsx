import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { startOfTWDay } from '@/lib/tz';
import {
  INSURANCE_KIND_LABEL,
  PREMIUM_FREQUENCY_LABEL,
  type InsuranceAccountDetails,
  type InsuranceKind,
  type PensionAccountDetails,
  type PremiumFrequency,
} from '../types';

const INSURANCE_KINDS = Object.keys(INSURANCE_KIND_LABEL) as InsuranceKind[];
const PREMIUM_FREQUENCIES = Object.keys(PREMIUM_FREQUENCY_LABEL) as PremiumFrequency[];

export function defaultInsuranceDetails(): InsuranceAccountDetails {
  return {
    insurer: '',
    kind: 'life',
    premiumTWD: 0,
    premiumFrequency: 'annual',
    nextPremiumDate: startOfTWDay(),
  };
}

export function defaultPensionDetails(): PensionAccountDetails {
  return { provider: '勞動部勞工保險局', employerContributionPct: 6 };
}

/** '' → undefined；其他轉數字（NaN 也回 undefined，交給 Zod 擋必填） */
function optionalNumberInput(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

interface InsuranceFieldsProps {
  value: InsuranceAccountDetails;
  onChange: (next: InsuranceAccountDetails) => void;
}

export function InsuranceFields({ value, onChange }: InsuranceFieldsProps) {
  const set = (patch: Partial<InsuranceAccountDetails>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>保險公司</Label>
          <Input value={value.insurer} onChange={(e) => set({ insurer: e.target.value })} placeholder="國泰人壽" />
        </div>
        <div>
          <Label>保單號碼（選填）</Label>
          <Input value={value.policyNo ?? ''} onChange={(e) => set({ policyNo: e.target.value || undefined })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>險種</Label>
          <Select value={value.kind} onValueChange={(v) => set({ kind: v as InsuranceKind })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {INSURANCE_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>{INSURANCE_KIND_LABEL[kind]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>繳費頻率</Label>
          <Select value={value.premiumFrequency} onValueChange={(v) => set({ premiumFrequency: v as PremiumFrequency })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {PREMIUM_FREQUENCIES.map((freq) => (
                <SelectItem key={freq} value={freq}>{PREMIUM_FREQUENCY_LABEL[freq]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>每期保費 TWD</Label>
          <Input
            type="number"
            inputMode="decimal"
            value={value.premiumTWD || ''}
            onChange={(e) => set({ premiumTWD: Number(e.target.value) || 0 })}
          />
        </div>
        <div>
          <Label>下次繳費日</Label>
          <DatePicker
            value={value.nextPremiumDate}
            onChange={(date) => set({ nextPremiumDate: date ?? value.nextPremiumDate })}
            clearable={false}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>保額 TWD（選填）</Label>
          <Input
            type="number"
            inputMode="decimal"
            value={value.coverageTWD ?? ''}
            onChange={(e) => set({ coverageTWD: optionalNumberInput(e.target.value) })}
          />
        </div>
        <div>
          <Label>滿期日（選填）</Label>
          <DatePicker value={value.maturityDate ?? null} onChange={(date) => set({ maturityDate: date ?? undefined })} />
        </div>
      </div>
      <div>
        <Label>解約金 / 保單價值 TWD（選填）</Label>
        <Input
          type="number"
          inputMode="decimal"
          value={value.cashValueTWD ?? ''}
          onChange={(e) => set({ cashValueTWD: optionalNumberInput(e.target.value) })}
          placeholder="純保障型留空"
        />
        <p className="mt-1 text-xs text-muted-foreground">淨值只計這一欄；純保障型保單沒有現金價值，不會算進資產。</p>
      </div>
    </div>
  );
}

interface PensionFieldsProps {
  value: PensionAccountDetails;
  onChange: (next: PensionAccountDetails) => void;
}

export function PensionFields({ value, onChange }: PensionFieldsProps) {
  const set = (patch: Partial<PensionAccountDetails>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div>
        <Label>管理機構</Label>
        <Input value={value.provider} onChange={(e) => set({ provider: e.target.value })} placeholder="勞動部勞工保險局" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label>雇主提繳 %</Label>
          <Input
            type="number"
            inputMode="decimal"
            value={value.employerContributionPct ?? ''}
            onChange={(e) => set({ employerContributionPct: optionalNumberInput(e.target.value) })}
          />
        </div>
        <div>
          <Label>自提 %</Label>
          <Input
            type="number"
            inputMode="decimal"
            value={value.selfContributionPct ?? ''}
            onChange={(e) => set({ selfContributionPct: optionalNumberInput(e.target.value) })}
          />
        </div>
        <div>
          <Label>月提繳工資</Label>
          <Input
            type="number"
            inputMode="decimal"
            value={value.monthlySalaryTWD ?? ''}
            onChange={(e) => set({ monthlySalaryTWD: optionalNumberInput(e.target.value) })}
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label>預期年報酬 %</Label>
          <Input
            type="number"
            inputMode="decimal"
            value={value.expectedReturnPct ?? ''}
            onChange={(e) => set({ expectedReturnPct: optionalNumberInput(e.target.value) })}
            placeholder="3"
          />
        </div>
        <div>
          <Label>退休年齡</Label>
          <Input
            type="number"
            inputMode="numeric"
            value={value.retirementAge ?? ''}
            onChange={(e) => set({ retirementAge: optionalNumberInput(e.target.value) })}
            placeholder="65"
          />
        </div>
        <div>
          <Label>出生年（西元）</Label>
          <Input
            type="number"
            inputMode="numeric"
            value={value.birthYear ?? ''}
            onChange={(e) => set({ birthYear: optionalNumberInput(e.target.value) })}
            placeholder="1990"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        餘額填目前專戶累積金額（以餘額計入淨值）。填了出生年就會試算退休時的預估金額。
      </p>
    </div>
  );
}
