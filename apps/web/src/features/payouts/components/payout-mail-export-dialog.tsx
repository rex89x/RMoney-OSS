import { useMemo, useState } from 'react';
import { Check, Clipboard, Code2, Download, ExternalLink, Mail, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { cn } from '@/lib/utils';
import { buildPayoutMailContent } from '../mail-export';
import type { PayoutGroup } from '../types';

interface PayoutMailExportDialogProps {
  group: PayoutGroup | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type CopyMode = 'rich' | 'html' | 'text';

export function PayoutMailExportDialog({ group, open, onOpenChange }: PayoutMailExportDialogProps) {
  const content = useMemo(() => group ? buildPayoutMailContent(group) : null, [group]);
  const [copied, setCopied] = useState<CopyMode | null>(null);

  if (!group || !content) return null;

  async function copyRichHtml() {
    if (!content) return;
    try {
      if ('ClipboardItem' in window) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([content.htmlFragment], { type: 'text/html' }),
            'text/plain': new Blob([content.plainText], { type: 'text/plain' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(content.plainText);
      }
      setCopied('rich');
      toast.success('已複製可貼到 Email 的格式內容');
    } catch (err) {
      console.error('[copyPayoutRichHtml]', err);
      toast.error('複製失敗，請改用下載 HTML');
    }
  }

  async function copyHtmlSource() {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content.htmlDocument);
      setCopied('html');
      toast.success('已複製 HTML 原始碼');
    } catch (err) {
      console.error('[copyPayoutHtmlSource]', err);
      toast.error('複製失敗');
    }
  }

  async function copyPlainText() {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content.plainText);
      setCopied('text');
      toast.success('已複製純文字明細');
    } catch (err) {
      console.error('[copyPayoutPlainText]', err);
      toast.error('複製失敗');
    }
  }

  function downloadHtml() {
    if (!content) return;
    const url = URL.createObjectURL(new Blob([content.htmlDocument], { type: 'text/html;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = content.fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  function openOutlook() {
    if (!content) return;
    window.open(content.outlookUrl, '_blank', 'noopener,noreferrer');
  }

  const footer = (
    <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
      <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
        關閉
      </Button>
      <Button type="button" onClick={copyRichHtml}>
        {copied === 'rich' ? <Check className="size-4" /> : <Clipboard className="size-4" />}
        複製信件內容
      </Button>
    </div>
  );

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Email 明細"
      description="可複製格式化內容貼到信件本文，也可下載完整 HTML 檔。"
      footer={footer}
      contentClassName="max-w-5xl"
    >
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-4">
          <ActionButton active={copied === 'rich'} icon={Clipboard} label="複製格式" onClick={copyRichHtml} />
          <ActionButton active={copied === 'html'} icon={Code2} label="複製 HTML" onClick={copyHtmlSource} />
          <ActionButton active={false} icon={Download} label="下載 HTML" onClick={downloadHtml} />
          <ActionButton active={false} icon={ExternalLink} label="開 Outlook" onClick={openOutlook} />
        </div>

        <div className="rounded-md border bg-muted/30 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Mail className="size-4" />
            {content.subject}
          </div>
          <div className="overflow-hidden rounded-md border bg-white">
            <iframe
              title={`${group.title} email preview`}
              srcDoc={content.htmlDocument}
              className="h-[520px] w-full bg-white"
            />
          </div>
        </div>

        <div className="rounded-md border bg-muted/30 p-3">
          <div className="mb-2 text-sm font-medium text-muted-foreground">純文字備援</div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 text-xs leading-relaxed">
            {content.plainText}
          </pre>
          <div className="mt-2 flex justify-end">
            <Button type="button" size="sm" variant="outline" onClick={copyPlainText}>
              {copied === 'text' ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}
              複製純文字
            </Button>
          </div>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

interface ActionButtonProps {
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void | Promise<void>;
}

function ActionButton({ active, icon: Icon, label, onClick }: ActionButtonProps) {
  return (
    <Button
      type="button"
      variant="outline"
      className={cn('justify-start', active && 'border-emerald-500 text-emerald-600')}
      onClick={() => void onClick()}
    >
      {active ? <Check className="size-4" /> : <Icon className="size-4" />}
      {label}
    </Button>
  );
}
