import { cn } from '@/lib/utils';
import type { HouseholdMember } from '../types';

interface MemberChipProps {
  member?: HouseholdMember;
  active?: boolean;
  onClick?: () => void;
  suffix?: string;
  className?: string;
}

export function memberInitial(member?: HouseholdMember): string {
  const name = member?.displayName ?? member?.email ?? '?';
  return name.trim().slice(0, 1).toUpperCase();
}

/** 成員小圓標（顏色 + 首字）＋名字；可當按鈕 */
export function MemberChip({ member, active, onClick, suffix, className }: MemberChipProps) {
  const color = member?.color ?? '#6b7280';
  const inner = (
    <>
      <span
        className="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{ backgroundColor: color }}
      >
        {memberInitial(member)}
      </span>
      <span className="truncate">{member?.displayName ?? '成員'}{suffix ?? ''}</span>
    </>
  );
  if (!onClick) {
    return <span className={cn('inline-flex items-center gap-1.5 text-sm', className)}>{inner}</span>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
        active ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
        className,
      )}
    >
      {inner}
    </button>
  );
}
