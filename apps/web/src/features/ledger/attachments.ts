/**
 * 交易附件（F10）純函式：驗證、Storage 路徑、舊 `photoUrl` 相容。
 * 不 import firebase，tests/attachments.test.cjs 直接 bundle。
 *
 * 規則：
 *   - 最多 5 個附件
 *   - 圖片：上傳前一律 compressImage 成 WebP ≤ 500KB（pitfall #20）；原檔最大 20MB（避免手機吃爆記憶體）
 *   - PDF：< 5MB 原樣上傳（與 Storage rules 的 size < 5MB 一致）；其他類型（含 SVG）一律拒絕（Storage rules 同步擋）
 *   - 路徑：tx-receipts/{uid}/{txId}/{timestamp}-{safeName}
 *   - 舊交易只有 `photoUrl`：converter 把它映射成 attachments[0] 顯示；
 *     存檔時仍寫 `photoUrl = 第一張圖片`，讓只認 photoUrl 的舊程式碼繼續可用
 */

export interface TxAttachment {
  url: string;
  /** Storage 物件路徑；舊 photoUrl 映射過來、又解析不出路徑時為空字串（無法刪 Storage 物件） */
  path: string;
  name: string;
  contentType: string;
  size: number;
  uploadedAt: Date;
}

export const MAX_TX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_IMAGE_BYTES = 500 * 1024;
export const MAX_ATTACHMENT_PDF_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_ACCEPT = 'image/*,application/pdf';

const RASTER_IMAGE_RE = /^image\/(png|jpeg|jpg|webp|gif|heic|heif|avif)$/i;

export type AttachmentKind = 'image' | 'pdf';

export function attachmentKind(contentType: string): AttachmentKind | null {
  if (RASTER_IMAGE_RE.test(contentType)) return 'image';
  if (contentType.toLowerCase() === 'application/pdf') return 'pdf';
  return null;
}

export function isImageAttachment(att: Pick<TxAttachment, 'contentType'>): boolean {
  return attachmentKind(att.contentType) === 'image';
}

export type AttachmentValidation =
  | { ok: true; kind: AttachmentKind }
  | { ok: false; error: string };

/** 選檔時的檢查（圖片的 500KB 限制在壓縮後才檢查，這裡只擋原檔過大） */
export function validateAttachmentFile(
  file: { name: string; type: string; size: number },
  existingCount: number,
): AttachmentValidation {
  if (existingCount >= MAX_TX_ATTACHMENTS) return { ok: false, error: `最多 ${MAX_TX_ATTACHMENTS} 個附件` };
  // 有些 Android 檔案選擇器給空 type：用副檔名判斷 PDF
  const type = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : '');
  const kind = attachmentKind(type);
  if (!kind) return { ok: false, error: `「${file.name}」不支援，只能上傳圖片或 PDF` };
  // Storage rules 是 size < 5MB（嚴格小於），這裡同一個邊界
  if (kind === 'pdf' && file.size >= MAX_ATTACHMENT_PDF_BYTES) {
    return { ok: false, error: `「${file.name}」需小於 5MB，PDF 請先壓縮` };
  }
  if (kind === 'image' && file.size > MAX_ATTACHMENT_SOURCE_IMAGE_BYTES) {
    return { ok: false, error: `「${file.name}」超過 20MB` };
  }
  return { ok: true, kind };
}

/** 檔名清成 Storage 安全字元（保留中文），最長 60 字，保留副檔名 */
export function safeAttachmentName(name: string): string {
  const trimmed = name.trim() || 'file';
  const dot = trimmed.lastIndexOf('.');
  const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  // 副檔名：最後一個 '.' 要在最後一個斜線之後、不是開頭，且是 1–8 個英數字
  const rawExt = dot > 0 && dot > lastSlash + 1 ? trimmed.slice(dot + 1) : '';
  const hasExt = /^[a-z0-9]{1,8}$/i.test(rawExt);
  const ext = hasExt ? rawExt.toLowerCase() : '';
  const base = (hasExt ? trimmed.slice(0, dot) : trimmed)
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'file';
  return ext ? `${base}.${ext}` : base;
}

/** 圖片壓縮後副檔名換成實際輸出格式（webp / jpg） */
export function replaceExtension(name: string, contentType: string): string {
  const ext = contentType === 'image/webp' ? 'webp' : contentType === 'image/jpeg' ? 'jpg' : null;
  if (!ext) return name;
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
}

export function attachmentStoragePath(uid: string, txId: string, fileName: string, now: number): string {
  return ['tx-receipts', uid, txId, `${now}-${safeAttachmentName(fileName)}`].join('/');
}

/**
 * 從 Firebase Storage download URL 反推物件路徑：
 *   https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{encodedPath}?alt=media&token=…
 * 舊 photoUrl 沒存 path，刪除附件時靠這個 best-effort 刪 Storage 物件。解析不出來回 ''。
 */
export function storagePathFromDownloadUrl(url: string): string {
  const match = /\/o\/([^?#]+)/.exec(url);
  if (!match?.[1]) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

function toDateLoose(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value && typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    const d = (value as { toDate: () => Date }).toDate();
    return d instanceof Date ? d : null;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Firestore raw → TxAttachment[]。
 * - 有 attachments 陣列就用它（壞掉的元素略過）
 * - 沒有但有舊 photoUrl → 映射成單一圖片附件（uploadedAt 用交易的 createdAt）
 */
export function decodeAttachments(raw: unknown, legacyPhotoUrl: unknown, fallbackDate: Date): TxAttachment[] {
  if (Array.isArray(raw) && raw.length > 0) {
    const out: TxAttachment[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      if (typeof r.url !== 'string' || !r.url) continue;
      out.push({
        url: r.url,
        path: typeof r.path === 'string' ? r.path : storagePathFromDownloadUrl(r.url),
        name: typeof r.name === 'string' && r.name ? r.name : 'attachment',
        contentType: typeof r.contentType === 'string' && r.contentType ? r.contentType : 'application/octet-stream',
        size: typeof r.size === 'number' && Number.isFinite(r.size) ? r.size : 0,
        uploadedAt: toDateLoose(r.uploadedAt) ?? fallbackDate,
      });
    }
    return out.slice(0, MAX_TX_ATTACHMENTS);
  }
  if (typeof legacyPhotoUrl === 'string' && legacyPhotoUrl) {
    return [{
      url: legacyPhotoUrl,
      path: storagePathFromDownloadUrl(legacyPhotoUrl),
      name: 'receipt',
      contentType: 'image/webp',
      size: 0,
      uploadedAt: fallbackDate,
    }];
  }
  return [];
}

/** 存檔時同步寫的舊欄位：第一張圖片的 URL（PDF 不算） */
export function legacyPhotoUrlFor(attachments: TxAttachment[]): string | null {
  return attachments.find(isImageAttachment)?.url ?? null;
}

/** 只比 url 序列：同一組附件、同樣順序 → 不用寫 */
export function sameAttachments(a: TxAttachment[] | undefined, b: TxAttachment[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((att, i) => att.url === right[i]?.url);
}

/** 原本有、現在沒有的附件（存檔成功後 best-effort 刪 Storage 物件） */
export function removedAttachments(before: TxAttachment[] | undefined, after: TxAttachment[]): TxAttachment[] {
  const keep = new Set(after.map((att) => att.url));
  return (before ?? []).filter((att) => !keep.has(att.url));
}

export function formatAttachmentSize(bytes: number): string {
  if (!(bytes > 0)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
