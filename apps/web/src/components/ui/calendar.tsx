import { DayPicker, type ChevronProps } from 'react-day-picker';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { zhTW } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function Chevron(props: ChevronProps) {
  if (props.orientation === 'left') return <ChevronLeft className="size-4" />;
  if (props.orientation === 'right') return <ChevronRight className="size-4" />;
  if (props.orientation === 'up') return <ChevronUp className="size-3.5" />;
  return <ChevronDown className="size-3.5" />;
}

export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = 'dropdown',
  startMonth,
  endMonth,
  ...props
}: CalendarProps) {
  const now = new Date();
  const defaultStart = new Date(now.getFullYear() - 15, 0, 1);
  const defaultEnd = new Date(now.getFullYear() + 5, 11, 31);
  return (
    <DayPicker
      locale={zhTW}
      showOutsideDays={showOutsideDays}
      captionLayout={captionLayout}
      startMonth={startMonth ?? defaultStart}
      endMonth={endMonth ?? defaultEnd}
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col sm:flex-row gap-2',
        month: 'flex flex-col gap-2',
        month_caption: 'flex justify-center pt-1 relative items-center gap-2',
        caption_label: 'inline-flex items-center gap-1 text-sm font-medium',
        dropdowns: 'flex items-center gap-1.5',
        // Make the dropdown root look like a tappable, visible button on mobile.
        // The native <select> remains transparent on top so the OS picker still opens,
        // but the wrapper now has a clear border + chevron so users can tell it's interactive.
        dropdown_root:
          'relative inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-sm shadow-sm hover:bg-muted focus-within:ring-2 focus-within:ring-ring',
        dropdown:
          'absolute inset-0 z-10 cursor-pointer appearance-none border-0 bg-transparent text-transparent opacity-0 outline-none',
        years_dropdown: '',
        months_dropdown: '',
        nav: 'flex items-center gap-1 absolute inset-x-0 top-1 justify-between px-1',
        button_previous: cn(buttonVariants({ variant: 'outline', size: 'icon-sm' }), 'bg-transparent'),
        button_next: cn(buttonVariants({ variant: 'outline', size: 'icon-sm' }), 'bg-transparent'),
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'text-muted-foreground rounded-md w-10 font-normal text-[0.8rem] lg:w-8',
        week: 'flex w-full mt-1',
        day: cn(
          'relative p-0 text-center text-sm focus-within:relative focus-within:z-20',
        ),
        day_button: cn(
          buttonVariants({ variant: 'ghost' }),
          // 手機上日期格放大到 40px，手指點得準；桌面維持 32px
          'size-10 p-0 font-normal aria-selected:opacity-100 lg:size-8',
        ),
        range_start: 'day-range-start rounded-l-md bg-primary text-primary-foreground',
        range_end: 'day-range-end rounded-r-md bg-primary text-primary-foreground',
        range_middle: 'bg-accent text-accent-foreground',
        selected:
          'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground',
        today: 'bg-accent text-accent-foreground rounded-md',
        outside: 'day-outside text-muted-foreground/60',
        disabled: 'text-muted-foreground opacity-50',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{ Chevron }}
      {...props}
    />
  );
}
