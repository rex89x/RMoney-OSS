import { auth } from '@/lib/firebase';
import { compressImageUnder, deleteStorageObject, uploadFile } from '@/lib/upload';
import {
  MAX_ATTACHMENT_IMAGE_BYTES,
  attachmentStoragePath,
  replaceExtension,
  validateAttachmentFile,
  type TxAttachment,
} from './attachments';

/**
 * 上傳一個交易附件：圖片先壓成 WebP ≤ 500KB，PDF 原樣上傳。
 * 路徑 tx-receipts/{uid}/{txId}/{timestamp}-{safeName}（Storage rules 只允許本人寫自己的 uid）。
 */
export async function uploadTxAttachment(file: File, txId: string, existingCount: number): Promise<TxAttachment> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('請先登入');
  const check = validateAttachmentFile(file, existingCount);
  if (!check.ok) throw new Error(check.error);
  const blob: Blob = check.kind === 'image' ? await compressImageUnder(file, MAX_ATTACHMENT_IMAGE_BYTES) : file;
  const contentType = check.kind === 'image' ? (blob.type || 'image/webp') : 'application/pdf';
  const name = check.kind === 'image' ? replaceExtension(file.name || 'photo', contentType) : (file.name || 'document.pdf');
  return uploadTxBlob(blob, txId, name, contentType);
}

/** 已經處理好的 blob（例：收據掃描已壓縮過的圖）直接上傳成附件 */
export async function uploadTxBlob(blob: Blob, txId: string, name: string, contentType: string): Promise<TxAttachment> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('請先登入');
  const now = Date.now();
  const path = attachmentStoragePath(uid, txId, name, now);
  const url = await uploadFile(path, blob, contentType);
  return { url, path, name, contentType, size: blob.size, uploadedAt: new Date(now) };
}

export async function deleteTxAttachmentObjects(attachments: TxAttachment[]): Promise<void> {
  await Promise.all(attachments.map((att) => deleteStorageObject(att.path)));
}
