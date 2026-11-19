import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Camera, FileText, Loader2, Paperclip, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  ATTACHMENT_ACCEPT,
  MAX_TX_ATTACHMENTS,
  formatAttachmentSize,
  isImageAttachment,
  type TxAttachment,
} from '../attachments';
import { deleteTxAttachmentObjects, uploadTxAttachment } from '../attachments-upload';

interface AttachmentsEditorProps {
  value: TxAttachment[];
  onChange: Dispatch<SetStateAction<TxAttachment[]>>;
  /** Storage 資料夾：tx-receipts/{uid}/{txId}/… */
  txId: string;
  /**
   * true：移除時立刻刪 Storage 物件（快速記帳：交易還沒存，沒有任何文件引用它）。
   * false：只從清單拿掉，由呼叫端在存檔成功後刪（編輯交易：取消編輯時檔案還要在）。
   */
  deleteOnRemove?: boolean;
  /** 外部忙碌中（例：收據辨識） */
  busy?: boolean;
  className?: string;
}

/** 交易附件清單：圖片縮圖 / PDF 圖示、點開新分頁、移除、可一次選多個檔 */
export function AttachmentsEditor({ value, onChange, txId, deleteOnRemove = false, busy = false, className }: AttachmentsEditorProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const full = value.length >= MAX_TX_ATTACHMENTS;
  const disabled = busy || uploading > 0 || full;

  async function handleFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    const room = MAX_TX_ATTACHMENTS - value.length;
    if (files.length > room) toast.error(`最多 ${MAX_TX_ATTACHMENTS} 個附件，只會上傳前 ${Math.max(0, room)} 個`);
    const picked = files.slice(0, Math.max(0, room));
    setUploading(picked.length);
    let count = value.length;
    for (const file of picked) {
      try {
        const att = await uploadTxAttachment(file, txId, count);
        count += 1;
        onChange((prev) => [...prev, att].slice(0, MAX_TX_ATTACHMENTS));
      } catch (err) {
        console.error('[uploadTxAttachment]', err);
        toast.error(err instanceof Error ? err.message : `「${file.name}」上傳失敗`);
      } finally {
        setUploading((n) => Math.max(0, n - 1));
      }
    }
  }

  function remove(att: TxAttachment) {
    onChange((prev) => prev.filter((row) => row.url !== att.url));
    if (deleteOnRemove) void deleteTxAttachmentObjects([att]);
  }

  return (
    <div className={cn('rounded-xl border p-3', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Paperclip className="size-4 text-muted-foreground" /> 附件
          <span className="text-xs font-normal text-muted-foreground">{value.length}/{MAX_TX_ATTACHMENTS}</span>
        </span>
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => { void handleFiles(e.target.files); e.target.value = ''; }}
        />
        <input
          ref={fileRef}
          type="file"
          accept={ATTACHMENT_ACCEPT}
          multiple
          hidden
          onChange={(e) => { void handleFiles(e.target.files); e.target.value = ''; }}
        />
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => cameraRef.current?.click()} disabled={disabled} aria-label="拍照">
            <Camera className="size-4" />
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={disabled}>
            {uploading > 0 ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
            {uploading > 0 ? `上傳中（${uploading}）` : '加附件'}
          </Button>
        </div>
      </div>
      {value.length > 0 ? (
        <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
          {value.map((att) => (
            <li key={att.url} className="group relative">
              <a
                href={att.url}
                target="_blank"
                rel="noreferrer"
                className="flex aspect-square flex-col items-center justify-center overflow-hidden rounded-md border bg-muted/40 text-center"
                title={att.name}
              >
                {isImageAttachment(att) ? (
                  <img src={att.url} alt={att.name} className="size-full object-cover" loading="lazy" />
                ) : (
                  <>
                    <FileText className="size-6 text-muted-foreground" />
                    <span className="mt-1 line-clamp-2 break-all px-1 text-[10px] leading-tight text-muted-foreground">{att.name}</span>
                    {att.size > 0 ? <span className="text-[10px] text-muted-foreground/70">{formatAttachmentSize(att.size)}</span> : null}
                  </>
                )}
              </a>
              <button
                type="button"
                onClick={() => remove(att)}
                className="absolute right-1 top-1 rounded-full bg-background/90 p-0.5 text-muted-foreground shadow-sm hover:text-destructive"
                aria-label={`移除 ${att.name}`}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">收據、發票、合約…最多 {MAX_TX_ATTACHMENTS} 個；圖片自動壓縮，PDF 上限 5MB</p>
      )}
    </div>
  );
}
