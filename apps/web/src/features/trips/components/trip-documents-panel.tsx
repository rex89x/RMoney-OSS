import { useMemo, useRef, useState } from 'react';
import {
  ExternalLink, FileText, FilePlus2, Hotel, Link2, Loader2, Plane, ShieldCheck, Sparkles,
  Ticket, Trash2, Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { useAuth } from '@/hooks/use-auth';
import { uploadFile } from '@/lib/upload';
import { callAppsScript } from '@/lib/apps-script';
import { cn } from '@/lib/utils';
import { formatTW } from '@/lib/tz';
import { useConfirm } from '@/components/ui/confirm';
import {
  useAddTripDocument, useDeleteTripDocument, useTripDocuments, useUpdateTripDocument,
} from '../hooks';
import type { Trip, TripDocument, TripDocumentCategory } from '../types';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ACCEPT_TYPES = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
];

const CATEGORY_LABEL: Record<TripDocumentCategory, string> = {
  visa: '簽證',
  flight: '機票',
  hotel: '訂房',
  insurance: '保險',
  ticket: '票券',
  other: '其他',
};

const CATEGORY_ICON: Record<TripDocumentCategory, React.ComponentType<{ className?: string }>> = {
  visa: ShieldCheck,
  flight: Plane,
  hotel: Hotel,
  insurance: ShieldCheck,
  ticket: Ticket,
  other: FileText,
};

const CATEGORY_ORDER: TripDocumentCategory[] = ['visa', 'flight', 'hotel', 'insurance', 'ticket', 'other'];

export function TripDocumentsPanel({ trip }: { trip: Trip }) {
  const { user, profile } = useAuth();
  const isOwner = trip.userId === user?.uid || trip.ownerId === user?.uid || profile?.role === 'admin';
  const { data: docs = [], isLoading } = useTripDocuments(trip.id);
  const add = useAddTripDocument(trip.id);
  const update = useUpdateTripDocument(trip.id);
  const del = useDeleteTripDocument(trip.id);
  const confirm = useConfirm();

  const [linkOpen, setLinkOpen] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);

  const grouped = useMemo(() => {
    const map = new Map<TripDocumentCategory, TripDocument[]>();
    for (const c of CATEGORY_ORDER) map.set(c, []);
    for (const d of docs) {
      const cat = (d.category && map.has(d.category) ? d.category : 'other') as TripDocumentCategory;
      map.get(cat)!.push(d);
    }
    return CATEGORY_ORDER.map((c) => ({ category: c, items: map.get(c) ?? [] }));
  }, [docs]);

  async function handleDelete(d: TripDocument) {
    const ok = await confirm({
      title: '刪除這份文件？',
      description: `${d.title} — Drive 上的副本（如果有）需自行清理`,
      confirmText: '刪除',
    });
    if (!ok) return;
    await del.mutateAsync({ docId: d.id, storagePath: d.storagePath });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-2 pb-2 sm:flex-row sm:items-center">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="size-4" /> 旅程文件
          </CardTitle>
          {isOwner ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setLinkOpen(true)}>
                <Link2 className="size-4" /> 新增連結
              </Button>
              <Button size="sm" onClick={() => setFileOpen(true)}>
                <Upload className="size-4" /> 上傳檔案
              </Button>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">（你是被分享的讀者，僅可瀏覽）</span>
          )}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-md" />
              ))}
            </div>
          ) : docs.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              <FilePlus2 className="mx-auto mb-2 size-5" />
              還沒有文件。點上方「新增連結 / 上傳檔案」開始整理簽證、機票、訂房 PDF。
            </div>
          ) : (
            <div className="space-y-4">
              {grouped.map(({ category, items }) => {
                if (items.length === 0) return null;
                const Icon = CATEGORY_ICON[category];
                return (
                  <div key={category}>
                    <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <Icon className="size-3.5" /> {CATEGORY_LABEL[category]}
                      <span className="text-[10px]">（{items.length}）</span>
                    </div>
                    <ul className="space-y-1.5">
                      {items.map((d) => (
                        <DocumentRow
                          key={d.id}
                          doc={d}
                          canDelete={isOwner}
                          onDelete={() => void handleDelete(d)}
                        />
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {isOwner && (
        <>
          <AddLinkDialog
            open={linkOpen}
            onOpenChange={setLinkOpen}
            tripId={trip.id}
            onSubmit={(input) => add.mutateAsync(input)}
          />
          <UploadFileDialog
            open={fileOpen}
            onOpenChange={setFileOpen}
            tripId={trip.id}
            uid={user?.uid ?? ''}
            onAdd={(input) => add.mutateAsync(input)}
            onUpdate={update.mutateAsync}
          />
        </>
      )}
    </div>
  );
}

function DocumentRow({
  doc, canDelete, onDelete,
}: { doc: TripDocument; canDelete: boolean; onDelete: () => void }) {
  return (
    <li className="flex items-start gap-2 rounded-md border bg-card p-2.5 text-sm">
      <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
        {doc.type === 'file' ? <FileText className="size-4" /> : <Link2 className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{doc.title || '(未命名)'}</div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>{formatTW(doc.createdAt, 'yyyy/MM/dd')}</span>
          {doc.size ? <span>· {formatBytes(doc.size)}</span> : null}
          {doc.contentType ? <span>· {doc.contentType.split('/').pop()}</span> : null}
          {doc.driveLink ? (
            <a
              href={doc.driveLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-primary hover:underline"
            >
              <Sparkles className="size-3" /> Drive
            </a>
          ) : null}
        </div>
        {doc.note ? <div className="text-[11px] text-muted-foreground">{doc.note}</div> : null}
      </div>
      <a
        href={doc.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1.5 text-xs hover:bg-muted"
      >
        <ExternalLink className="size-3" /> 開啟
      </a>
      {canDelete ? (
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label="刪除"
        >
          <Trash2 className="size-3.5" />
        </button>
      ) : null}
    </li>
  );
}

function AddLinkDialog({
  open, onOpenChange, tripId, onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tripId: string;
  onSubmit: (input: Omit<TripDocument, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
}) {
  const { user } = useAuth();
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState<TripDocumentCategory>('visa');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!title.trim() || !url.trim()) return;
    setSubmitting(true);
    try {
      const docId = await onSubmit({
        type: 'link',
        title: title.trim(),
        url: url.trim(),
        category,
        note: note.trim() || null,
        createdBy: user?.uid ?? '',
      });
      // 背景同步到 Drive，失敗不阻擋
      void callAppsScript('syncTripDocument', undefined, {
        tripId, docId, title: title.trim(), url: url.trim(),
      }).catch((err) => console.warn('[syncTripDocument link]', err));
      toast.success('已新增連結');
      setTitle(''); setUrl(''); setNote('');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '新增失敗');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="新增連結"
      description="儲存簽證查詢網址、訂房連結等。會同步到 Drive 對應 trip 資料夾。"
      contentClassName="sm:max-w-md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting || !title.trim() || !url.trim()}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            儲存
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>標題</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：日本電子簽證查詢頁面" />
        </div>
        <div>
          <Label>網址</Label>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
        </div>
        <div>
          <Label>分類</Label>
          <CategorySelect value={category} onChange={setCategory} />
        </div>
        <div>
          <Label>備註</Label>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </div>
      </div>
    </ResponsiveDialog>
  );
}

function UploadFileDialog({
  open, onOpenChange, tripId, uid, onAdd, onUpdate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tripId: string;
  uid: string;
  onAdd: (input: Omit<TripDocument, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  onUpdate: (args: { docId: string; patch: Partial<TripDocument> }) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<TripDocumentCategory>('visa');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSelectFile(f: File | null) {
    if (!f) {
      setFile(null);
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      toast.error(`檔案超過 ${formatBytes(MAX_FILE_BYTES)} 上限`);
      return;
    }
    if (!ACCEPT_TYPES.includes(f.type) && f.type) {
      toast.warning(`類型 ${f.type} 可能不被允許上傳`);
    }
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
  }

  async function handleSubmit() {
    if (!file || !uid) return;
    setUploading(true);
    try {
      // 1. 先建 Firestore doc 拿 docId（讓 Storage path 含 docId）
      const docId = await onAdd({
        type: 'file',
        title: title.trim() || file.name,
        url: '',
        category,
        note: note.trim() || null,
        createdBy: uid,
        contentType: file.type || null,
        size: file.size,
      });
      const safeName = file.name.replace(/[^\w.\- ]+/g, '_');
      const path = `trip-documents/${uid}/${tripId}/${docId}/${safeName}`;
      const url = await uploadFile(path, file, file.type || 'application/octet-stream');
      await onUpdate({
        docId,
        patch: { storagePath: path, url },
      });
      // 背景同步到 Drive（base64 限制：Apps Script 6MB body / response — 大檔可能失敗，會 console.warn）
      try {
        const base64 = await fileToBase64(file);
        void callAppsScript('syncTripDocument', undefined, {
          tripId,
          docId,
          title: title.trim() || file.name,
          fileBase64: base64,
          fileName: safeName,
          contentType: file.type || 'application/octet-stream',
        }).catch((err) => console.warn('[syncTripDocument file]', err));
      } catch (err) {
        console.warn('[fileToBase64]', err);
      }
      toast.success('已上傳');
      setTitle(''); setNote(''); setFile(null);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '上傳失敗');
    } finally {
      setUploading(false);
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="上傳文件"
      description="支援 PDF / 圖片 / 文件，每檔上限 25MB。會同步到 Drive 對應 trip 資料夾。"
      contentClassName="sm:max-w-md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={uploading || !file}
          >
            {uploading ? <Loader2 className="size-4 animate-spin" /> : null}
            上傳
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>檔案</Label>
          <div
            className={cn(
              'mt-1 cursor-pointer rounded-md border border-dashed p-4 text-center text-sm transition-colors hover:bg-muted/30',
              file && 'border-primary bg-primary/5',
            )}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) handleSelectFile(f);
            }}
          >
            {file ? (
              <>
                <FileText className="mx-auto size-5" />
                <div className="mt-1 truncate font-medium">{file.name}</div>
                <div className="text-xs text-muted-foreground">
                  {formatBytes(file.size)}{file.type ? ` · ${file.type}` : ''}
                </div>
              </>
            ) : (
              <>
                <Upload className="mx-auto size-5 text-muted-foreground" />
                <div className="mt-1 text-muted-foreground">點此或拖曳檔案到這裡</div>
                <div className="text-xs text-muted-foreground">PDF / 圖片 / 文件 ≤ 25MB</div>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              hidden
              accept={ACCEPT_TYPES.join(',')}
              onChange={(e) => handleSelectFile(e.target.files?.[0] ?? null)}
            />
          </div>
        </div>
        <div>
          <Label>標題</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Label>分類</Label>
          <CategorySelect value={category} onChange={setCategory} />
        </div>
        <div>
          <Label>備註</Label>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </div>
      </div>
    </ResponsiveDialog>
  );
}

function CategorySelect({
  value, onChange,
}: { value: TripDocumentCategory; onChange: (v: TripDocumentCategory) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TripDocumentCategory)}>
      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
      <SelectContent>
        {CATEGORY_ORDER.map((c) => (
          <SelectItem key={c} value={c}>{CATEGORY_LABEL[c]}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result;
      if (typeof r !== 'string') {
        reject(new Error('FileReader returned non-string'));
        return;
      }
      const idx = r.indexOf('base64,');
      resolve(idx >= 0 ? r.slice(idx + 7) : r);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
