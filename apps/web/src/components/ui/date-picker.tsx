import { CalendarIcon, X } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { formatTW, formatTWDateInput, parseDateInput } from '@/lib/tz';
import { useIsDesktop } from '@/hooks/use-media-query';

/* -------- single date -------- */

export interface DatePickerProps {
  value?: Date | null;
  onChange: (date: Date | null) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  fromDate?: Date;
  toDate?: Date;
  clearable?: boolean;
  /** tokens like `yyyy/MM/dd`；預設 `yyyy-MM-dd (eee)` */
  displayFormat?: string;
  /** 用於表單，固定高度 */
  size?: 'sm' | 'md';
}

export function DatePicker({
  value,
  onChange,
  placeholder = '選擇日期',
  className,
  disabled,
  fromDate,
  toDate,
  clearable = true,
  displayFormat = 'yyyy-MM-dd (eee)',
  size = 'md',
}: DatePickerProps) {
  const calendarValue = value ? (parseDateInput(formatTWDateInput(value)) ?? value) : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            'w-full justify-start text-left font-normal',
            !value && 'text-muted-foreground',
            size === 'sm' && 'h-9',
            className,
          )}
        >
          <CalendarIcon className="size-4" />
          <span className="flex-1 truncate">
            {value ? formatTW(value, displayFormat) : placeholder}
          </span>
          {value && clearable ? (
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); onChange(null); }}
              aria-label="清除日期"
              className="-my-2 -mr-2 ml-0 rounded-md p-2 text-muted-foreground hover:bg-muted"
            >
              <X className="size-3" />
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={calendarValue ?? undefined}
          onSelect={(d) => onChange(d ?? null)}
          fromDate={fromDate}
          toDate={toDate}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}

/* -------- date range -------- */

export interface DateRangePickerProps {
  value?: { from?: Date; to?: Date } | undefined;
  onChange: (range: { from?: Date; to?: Date } | undefined) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export function DateRangePicker({
  value,
  onChange,
  placeholder = '選擇區間',
  className,
  disabled,
  size = 'md',
}: DateRangePickerProps) {
  const isDesktop = useIsDesktop();
  const calendarValue = value
    ? {
      from: value.from ? (parseDateInput(formatTWDateInput(value.from)) ?? value.from) : undefined,
      to: value.to ? (parseDateInput(formatTWDateInput(value.to)) ?? value.to) : undefined,
    }
    : undefined;
  const display = (() => {
    if (!value?.from && !value?.to) return placeholder;
    if (value?.from && value?.to) {
      return `${formatTW(value.from, 'yyyy/MM/dd')} — ${formatTW(value.to, 'MM/dd')}`;
    }
    if (value?.from) return `自 ${formatTW(value.from, 'yyyy/MM/dd')}`;
    if (value?.to) return `至 ${formatTW(value.to, 'yyyy/MM/dd')}`;
    return placeholder;
  })();
  const hasValue = !!(value?.from || value?.to);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            'w-full justify-start text-left font-normal',
            !hasValue && 'text-muted-foreground',
            size === 'sm' && 'h-9',
            className,
          )}
        >
          <CalendarIcon className="size-4" />
          <span className="flex-1 truncate">{display}</span>
          {hasValue && (
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); onChange(undefined); }}
              aria-label="清除日期"
              className="-my-2 -mr-2 ml-0 rounded-md p-2 text-muted-foreground hover:bg-muted"
            >
              <X className="size-3" />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="max-h-[80dvh] w-auto overflow-y-auto p-0" align="start">
        <Calendar
          mode="range"
          selected={calendarValue as DateRange | undefined}
          onSelect={(r) => onChange(r ? { from: r.from, to: r.to } : undefined)}
          numberOfMonths={isDesktop ? 2 : 1}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}
