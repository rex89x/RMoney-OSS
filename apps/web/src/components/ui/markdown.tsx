import { useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Hash } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  children: string;
  className?: string;
  /** 啟用後 heading 會加 id（slug）+ hover 顯示 anchor 連結，給 HackMD 風格 reader 用 */
  withAnchors?: boolean;
  /**
   * 啟用 checklist 互動：傳這個 callback 後 `- [ ] xxx` 點擊會切換並回呼新 markdown。
   * 若 undefined 則 checklist 維持唯讀。
   */
  onChange?: (next: string) => void;
}

interface HeadingChild { props?: { children?: ReactNode } }
type HeadingProps = { children?: ReactNode } & Record<string, unknown>;

/**
 * 安全的 markdown 渲染器（HackMD 風）。
 * - 預設禁 raw HTML（不裝 rehype-raw）→ 防 XSS
 * - GFM：表格 / checklist / 刪除線 / 自動連結
 * - withAnchors：依「在原始 markdown 中的順序」給 H1–H4 一個 deterministic id
 *   （`heading-{n}`），TOC 用 extractHeadings 抓到完全相同 id，所以點擊百分百對得上。
 * - onChange：interactive checklist；點擊後回呼新 markdown，外層存回 Firestore
 */
export function Markdown({ children, className, withAnchors, onChange }: Props) {
  // headingIds 從原始 markdown 解析出每個 heading 的 id，照 1-based 順序：'heading-1' / 'heading-2' / ...
  const headingIds = useMemo(() => extractHeadings(children).map((h) => h.id), [children]);
  // 我們需要在原始 markdown 上找出每一個 task list 行的 index 來支援 toggle
  const taskLineIndexes = useMemo(() => collectTaskLineIndexes(children), [children]);
  let headingCounter = 0;
  let taskCounter = 0;

  return (
    <div
      className={cn(
        'prose prose-sm max-w-none break-words dark:prose-invert',
        // 標題：拉開上下間距、加粗、底線分隔（h1 / h2）
        'prose-headings:scroll-mt-24 prose-headings:font-semibold',
        'prose-h1:text-2xl prose-h1:mb-4 prose-h1:mt-6 prose-h1:pb-2 prose-h1:border-b prose-h1:border-border',
        'prose-h2:text-xl prose-h2:mb-3 prose-h2:mt-8 prose-h2:pb-1.5 prose-h2:border-b prose-h2:border-border/60',
        'prose-h3:text-lg prose-h3:mb-2 prose-h3:mt-6',
        'prose-h4:text-base prose-h4:mt-4',
        // 段落 / 清單 / 區塊引言
        'prose-p:my-3 prose-p:leading-7',
        'prose-li:my-1',
        'prose-blockquote:border-l-primary/60 prose-blockquote:bg-muted/40 prose-blockquote:py-1 prose-blockquote:px-3 prose-blockquote:not-italic',
        // 連結 / 行內 code / 區塊 code
        'prose-a:text-primary prose-a:underline-offset-2 hover:prose-a:underline',
        'prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-[""] prose-code:after:content-[""]',
        'prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-muted prose-pre:p-3 prose-pre:text-xs prose-pre:border prose-pre:border-border',
        // 圖片 / 表格 / 分隔線
        'prose-img:rounded-md prose-img:border prose-img:border-border',
        'prose-table:my-4',
        'prose-th:bg-muted/60 prose-th:text-left prose-th:px-3 prose-th:py-2',
        'prose-td:px-3 prose-td:py-2 prose-td:border-t prose-td:border-border',
        'prose-hr:my-6 prose-hr:border-border',
        // 強調
        'prose-strong:text-foreground',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
          table: ({ ...props }) => (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="m-0" {...props} />
            </div>
          ),
          h1: (p) => {
            const id = withAnchors ? headingIds[headingCounter] ?? `heading-${headingCounter + 1}` : undefined;
            headingCounter += 1;
            return renderHeading('h1', p as HeadingProps, withAnchors, id);
          },
          h2: (p) => {
            const id = withAnchors ? headingIds[headingCounter] ?? `heading-${headingCounter + 1}` : undefined;
            headingCounter += 1;
            return renderHeading('h2', p as HeadingProps, withAnchors, id);
          },
          h3: (p) => {
            const id = withAnchors ? headingIds[headingCounter] ?? `heading-${headingCounter + 1}` : undefined;
            headingCounter += 1;
            return renderHeading('h3', p as HeadingProps, withAnchors, id);
          },
          h4: (p) => {
            const id = withAnchors ? headingIds[headingCounter] ?? `heading-${headingCounter + 1}` : undefined;
            headingCounter += 1;
            return renderHeading('h4', p as HeadingProps, withAnchors, id);
          },
          input: (p: { type?: string; checked?: boolean; disabled?: boolean }) => {
            if (p.type !== 'checkbox') {
              return <input {...p} />;
            }
            const lineIndex = taskLineIndexes[taskCounter] ?? -1;
            taskCounter += 1;
            const editable = Boolean(onChange) && lineIndex >= 0;
            return (
              <input
                type="checkbox"
                checked={Boolean(p.checked)}
                disabled={!editable}
                onChange={(e) => {
                  if (!editable || !onChange) return;
                  const next = toggleTaskLine(children, lineIndex, e.target.checked);
                  if (next != null) onChange(next);
                }}
                className={cn(
                  'mr-1 align-middle accent-primary',
                  editable && 'cursor-pointer',
                )}
              />
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function renderHeading(
  tag: 'h1' | 'h2' | 'h3' | 'h4',
  props: HeadingProps,
  withAnchors: boolean | undefined,
  id: string | undefined,
) {
  const { children, ...rest } = props;
  const Comp = tag as 'h1';
  if (!withAnchors || !id) return <Comp {...rest}>{children}</Comp>;
  return (
    <Comp id={id} className="group relative scroll-mt-24" {...rest}>
      <a
        href={`#${id}`}
        aria-label="anchor"
        className="absolute -left-6 top-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => {
          e.preventDefault();
          const el = document.getElementById(id);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            history.replaceState(null, '', `#${id}`);
          }
        }}
      >
        <Hash className="size-3.5" />
      </a>
      {children}
    </Comp>
  );
}

void textOfChildren;
function textOfChildren(node: ReactNode): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOfChildren).join('');
  const child = node as HeadingChild;
  if (child.props && child.props.children !== undefined) return textOfChildren(child.props.children);
  return '';
}

function collectTaskLineIndexes(md: string): number[] {
  const out: number[] = [];
  const lines = md.split('\n');
  const re = /^(\s*[-*+]\s+)\[( |x|X)\](\s|$)/;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i] ?? '')) out.push(i);
  }
  return out;
}

function toggleTaskLine(md: string, lineIndex: number, checked: boolean): string | null {
  const lines = md.split('\n');
  const line = lines[lineIndex];
  if (line == null) return null;
  const re = /^(\s*[-*+]\s+)\[( |x|X)\](\s|$)/;
  if (!re.test(line)) return null;
  const next = line.replace(re, (_full, prefix: string, _box: string, tail: string) => {
    return `${prefix}[${checked ? 'x' : ' '}]${tail}`;
  });
  if (next === line) return null;
  lines[lineIndex] = next;
  return lines.join('\n');
}

/** Headings list（給 TOC 使用）— id 用 deterministic `heading-{n}`，1-based */
export interface MarkdownHeading {
  id: string;
  text: string;
  level: number;
}

export function extractHeadings(md: string): MarkdownHeading[] {
  const out: MarkdownHeading[] = [];
  const lines = md.split('\n');
  let inFence = false;
  let n = 0;
  for (const raw of lines) {
    const line = raw ?? '';
    // 跳過 ``` fenced code 內的內容
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    n += 1;
    const level = m[1]!.length; // 非空：regex 已匹配，群組一定存在
    const text = m[2]!.trim(); // 非空：regex 已匹配，群組一定存在
    out.push({ id: `heading-${n}`, text, level });
  }
  return out;
}
