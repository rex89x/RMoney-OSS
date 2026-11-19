import { Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface Props {
  value?: string;   // HH:MM
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** 分鐘間隔（預設 15） */
  stepMinutes?: number;
  /** 顯示的起訖小時，預設 0-23 */
  fromHour?: number;
  toHour?: number;
  size?: 'sm' | 'md';
}

export function TimePicker({
  value,
  onChange,
  placeholder = '選擇時間',
  className,
  disabled,
  stepMinutes = 15,
  fromHour = 0,
  toHour = 23,
  size = 'md',
}: Props) {
  const times: string[] = [];
  for (let h = fromHour; h <= toHour; h++) {
    for (let m = 0; m < 60; m += stepMinutes) {
      times.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  const validPattern = /^([01]?\d|2[0-3]):[0-5]\d$/;

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
          <Clock className="size-4" />
          <span className="flex-1 truncate">{value || placeholder}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="start">
        <div className="mb-2">
          <Input
            value={value ?? ''}
            placeholder="HH:MM"
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || validPattern.test(v)) onChange(v);
              else onChange(v); // 讓使用者打到一半也能輸入，只是目前格式不合
            }}
            className="h-9"
          />
        </div>
        <div className="grid max-h-64 grid-cols-3 gap-1 overflow-y-auto">
          {times.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onChange(t)}
              className={cn(
                'min-h-10 rounded-md px-2 py-1 text-center text-sm tabular-nums hover:bg-accent active:scale-95 transition-transform',
                value === t && 'bg-primary text-primary-foreground',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
