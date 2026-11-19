import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ComboboxOption {
  value: string;
  label: string;
  /** 顯示副標 */
  description?: string;
}

interface Props {
  value?: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** 允許輸入不在選項中的自由值 */
  allowCustom?: boolean;
  className?: string;
  disabled?: boolean;
  /** 控制顯示值（若提供會覆蓋預設的 label 查找） */
  displayValue?: string;
}

export function Combobox({
  value,
  onChange,
  options,
  placeholder = '選擇…',
  searchPlaceholder = '搜尋…',
  emptyText = '沒有符合結果',
  allowCustom = false,
  className,
  disabled,
  displayValue,
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const selected = options.find((o) => o.value === value);
  const label = displayValue ?? selected?.label ?? value ?? '';

  function commit(v: string) {
    onChange(v);
    setOpen(false);
    setSearch('');
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          disabled={disabled}
          className={cn('w-full justify-between font-normal', !label && 'text-muted-foreground', className)}
        >
          <span className="truncate">{label || placeholder}</span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command
          filter={(itemValue, s) => {
            // cmdk filter: itemValue is the 'value' prop of CommandItem
            const opt = options.find((o) => o.value === itemValue);
            if (!opt) return 0;
            const q = s.toLowerCase();
            const haystack = `${opt.label} ${opt.value} ${opt.description ?? ''}`.toLowerCase();
            return haystack.includes(q) ? 1 : 0;
          }}
        >
          <CommandInput
            placeholder={searchPlaceholder}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>
              {allowCustom && search ? (
                <button
                  type="button"
                  className="w-full px-2 py-1 text-sm hover:bg-accent"
                  onClick={() => commit(search.trim())}
                >
                  使用「{search}」
                </button>
              ) : emptyText}
            </CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem key={o.value} value={o.value} onSelect={() => commit(o.value)}>
                  <Check className={cn('size-4', value === o.value ? 'opacity-100' : 'opacity-0')} />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate">{o.label}</span>
                    {o.description && (
                      <span className="truncate text-xs text-muted-foreground">{o.description}</span>
                    )}
                  </div>
                </CommandItem>
              ))}
              {allowCustom && search && !options.some((o) => o.value.toLowerCase() === search.toLowerCase()) && (
                <CommandItem value={`__custom__${search}`} onSelect={() => commit(search.trim())}>
                  <Check className="size-4 opacity-0" />
                  <span className="text-muted-foreground">使用「{search.trim()}」</span>
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
