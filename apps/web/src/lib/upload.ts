import { getAppStorage, auth } from './firebase';

/**
 * 上傳前壓縮圖片到 maxWidth × maxHeight，輸出 WebP（or JPEG 後備）。
 */
export async function compressImage(file: File, maxDim = 1600, quality = 0.8): Promise<Blob> {
  const img = await loadImage(file);
  const { width, height } = scaleSize(img.width, img.height, maxDim);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(img, 0, 0, width, height);
  const mime = supportsWebp() ? 'image/webp' : 'image/jpeg';
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('canvas toBlob returned null'));
      else resolve(blob);
    }, mime, quality);
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function scaleSize(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= max && h <= max) return { width: w, height: h };
  if (w >= h) return { width: max, height: Math.round((h / w) * max) };
  return { width: Math.round((w / h) * max), height: max };
}

function supportsWebp(): boolean {
  const canvas = document.createElement('canvas');
  return canvas.toDataURL('image/webp').startsWith('data:image/webp');
}

/**
 * 上傳檔案到 storage path。回傳 download URL。
 * path 範例：`tx-receipts/{uid}/{txId}/{filename}`
 */
export async function uploadFile(path: string, file: Blob | File, contentType?: string): Promise<string> {
  const [{ ref, uploadBytes, getDownloadURL }, storage] = await Promise.all([
    import('firebase/storage'),
    getAppStorage(),
  ]);
  const r = ref(storage, path);
  await uploadBytes(r, file, contentType ? { contentType } : undefined);
  return await getDownloadURL(r);
}

/**
 * 壓縮到 maxBytes 以下（pitfall #20：照片 ≤ 500KB WebP）。
 * 依序降尺寸 / 品質重試；最後一輪仍超過就丟錯，不上傳超大檔。
 */
export async function compressImageUnder(file: File, maxBytes: number): Promise<Blob> {
  const attempts: Array<[number, number]> = [[1600, 0.82], [1400, 0.72], [1200, 0.62], [1000, 0.55], [800, 0.5]];
  for (const [dim, quality] of attempts) {
    const blob = await compressImage(file, dim, quality);
    if (blob.size <= maxBytes) return blob;
  }
  throw new Error('圖片壓縮後仍超過 500KB，請換一張解析度較低的圖');
}

/** best-effort 刪 Storage 物件（附件移除後清檔）；失敗只記 warn，不影響主流程 */
export async function deleteStorageObject(path: string): Promise<void> {
  if (!path) return;
  try {
    const [{ ref, deleteObject }, storage] = await Promise.all([import('firebase/storage'), getAppStorage()]);
    await deleteObject(ref(storage, path));
  } catch (err) {
    console.warn('[deleteStorageObject]', path, err);
  }
}

export function buildUserPath(scope: string, ...segments: string[]): string {
  const uid = auth.currentUser?.uid ?? 'anon';
  return [scope, uid, ...segments].join('/');
}
