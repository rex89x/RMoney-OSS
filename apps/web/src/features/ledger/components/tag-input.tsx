import { useState, type KeyboardEvent } from 'react';
import { Tag, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { normalizeTag, MAX_TAGS } from '../tags';

interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** 下拉建議（例如最近用過的 tag） */
  suggestions?: string[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

/** 交易標籤輸入：Enter / 逗號 / 空白新增，點 X 移除（SPEC §5.4.5 tags） */
export function TagInput({ value, onChange, suggestions = [], placeholder = '輸入後按 Enter 新增', className, disabled }: TagInputProps) {
  const [draft, setDraft] = useState('');
  const listId = 'tag-input-suggestions';

  function add(raw: string) {
    const tag = normalizeTag(raw);
    setDraft('');
    if (!tag || value.includes(tag) || value.length >= MAX_TAGS) return;
    onChange([...value, tag]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return; // 中文輸入法選字中的 Enter 不算
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  const available = suggestions.filter((s) => !value.includes(s));

  return (
    <div className={cn('space-y-1.5', className)}>
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
              <Tag className="size-3 text-muted-foreground" aria-hidden />
              {tag}
              {!disabled ? (
                <button
                  type="button"
                  onClick={() => onChange(value.filter((t) => t !== tag))}
                  aria-label={`移除標籤 ${tag}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      {!disabled && value.length < MAX_TAGS ? (
        <>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => { if (draft.trim()) add(draft); }}
            placeholder={placeholder}
            list={available.length ? listId : undefined}
            enterKeyHint="done"
          />
          {available.length ? (
            <datalist id={listId}>
              {available.slice(0, 30).map((s) => <option key={s} value={s} />)}
            </datalist>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
