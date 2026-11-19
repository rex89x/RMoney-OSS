import {
  cloneElement, isValidElement, useState, type MouseEvent, type ReactElement,
} from 'react';
import { Calendar, MapPin, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { DatePicker } from '@/components/ui/date-picker';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { formatCurrency, cn } from '@/lib/utils';
import { SYSTEM_TEMPLATES, type TripTemplate } from '../templates';

interface Props {
  trigger: React.ReactNode;
  onSelect: (template: TripTemplate, startDate: Date) => void | Promise<void>;
}

export function TemplatePicker({ trigger, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<TripTemplate | null>(null);
  const [startDate, setStartDate] = useState<Date | null>(() => new Date());

  async function handleConfirm() {
    if (!selected || !startDate) return;
    await onSelect(selected, startDate);
    setOpen(false);
    setSelected(null);
  }

  const triggerElement = isValidElement(trigger)
    ? cloneElement(trigger as ReactElement<{ onClick?: (event: MouseEvent) => void }>, {
        onClick: (event: MouseEvent) => {
          (trigger as ReactElement<{ onClick?: (event: MouseEvent) => void }>).props.onClick?.(event);
          setOpen(true);
        },
      })
    : trigger;

  return (
    <>
      {triggerElement}
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title="從模板建立行程"
        description="選擇一個內建模板快速生成 day / items，建立後可自由增減與調整。"
        contentClassName="sm:max-w-3xl"
        footer={(
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button onClick={() => void handleConfirm()} disabled={!selected || !startDate}>
              建立行程
            </Button>
          </div>
        )}
      >

        <div className="grid gap-3 md:grid-cols-2">
          {SYSTEM_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSelected(t)}
              className={cn(
                'rounded-xl border p-4 text-left transition-colors',
                selected?.id === t.id ? 'border-primary ring-2 ring-primary/30' : 'hover:bg-muted/50',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="font-medium">{t.name}</div>
                <Badge variant="secondary" className="shrink-0">{t.days} 天</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{t.description}</p>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1"><MapPin className="size-3" />{t.destinations.join(' · ')}</span>
                <span className="flex items-center gap-1"><Wallet className="size-3" />預估 {formatCurrency(t.estimatedBudgetTWD)}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {t.tags.map((tag) => (
                  <span key={tag} className="rounded-md bg-muted px-1.5 py-0.5 text-[10px]">{tag}</span>
                ))}
              </div>
            </button>
          ))}
        </div>

        <div className="border-t bg-muted/30 p-4">
          {selected ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">已選：{selected.name}</div>
                <div className="text-xs text-muted-foreground">{selected.days} 天 · 預估 {formatCurrency(selected.estimatedBudgetTWD)}</div>
              </div>
              <div className="min-w-[200px]">
                <Label className="text-xs flex items-center gap-1"><Calendar className="size-3" />出發日期</Label>
                <DatePicker size="sm" value={startDate} onChange={setStartDate} clearable={false} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">先從上方選一個模板</p>
          )}
        </div>
      </ResponsiveDialog>
    </>
  );
}
