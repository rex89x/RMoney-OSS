// F10 多附件：驗證、Storage 路徑、舊 photoUrl 相容映射
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');

function loadTs(entryPath) {
  const output = esbuild.buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', write: false,
    alias: { '@': path.resolve(__dirname, '../src') } }).outputFiles[0].text;
  const result = new Module(entryPath, module);
  result.filename = entryPath;
  result.paths = module.paths;
  result._compile(output, entryPath);
  return result.exports;
}

const att = loadTs(path.resolve(__dirname, '../src/features/ledger/attachments.ts'));

const MB = 1024 * 1024;
const url = (p) => `https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/${encodeURIComponent(p)}?alt=media&token=abc`;

test('validateAttachmentFile: 只收點陣圖與 PDF、PDF < 5MB、最多 5 個', () => {
  assert.deepEqual(att.validateAttachmentFile({ name: 'a.jpg', type: 'image/jpeg', size: 3 * MB }, 0), { ok: true, kind: 'image' });
  assert.deepEqual(att.validateAttachmentFile({ name: 'a.heic', type: 'image/heic', size: 3 * MB }, 4), { ok: true, kind: 'image' });
  assert.deepEqual(att.validateAttachmentFile({ name: 'b.pdf', type: 'application/pdf', size: 5 * MB - 1 }, 0), { ok: true, kind: 'pdf' });
  // 空 type 的 PDF（部分 Android 選擇器）用副檔名判斷
  assert.deepEqual(att.validateAttachmentFile({ name: 'scan.PDF', type: '', size: 1000 }, 0), { ok: true, kind: 'pdf' });

  const rejects = [
    [{ name: 'b.pdf', type: 'application/pdf', size: 5 * MB }, 0, /5MB/],
    [{ name: 'x.svg', type: 'image/svg+xml', size: 10 }, 0, /不支援/],
    [{ name: 'x.html', type: 'text/html', size: 10 }, 0, /不支援/],
    [{ name: 'x.zip', type: 'application/zip', size: 10 }, 0, /不支援/],
    [{ name: 'huge.png', type: 'image/png', size: 21 * MB }, 0, /20MB/],
    [{ name: 'ok.png', type: 'image/png', size: 10 }, 5, /最多 5 個/],
  ];
  for (const [file, count, re] of rejects) {
    const r = att.validateAttachmentFile(file, count);
    assert.equal(r.ok, false, file.name);
    assert.match(r.error, re);
  }
});

test('safeAttachmentName / attachmentStoragePath: tx-receipts/{uid}/{txId}/{timestamp}-{safeName}', () => {
  assert.equal(att.safeAttachmentName('收據 2026/11 (1).PDF'), '收據-2026-11-1.pdf');
  assert.equal(att.safeAttachmentName('../../etc/passwd'), 'etc-passwd');
  assert.equal(att.safeAttachmentName('   '), 'file');
  assert.equal(att.safeAttachmentName('.env'), 'env');
  assert.ok(att.safeAttachmentName('a'.repeat(200) + '.jpg').length <= 64);
  assert.equal(
    att.attachmentStoragePath('uid1', 'tx9', 'my receipt.webp', 1700000000000),
    'tx-receipts/uid1/tx9/1700000000000-my-receipt.webp',
  );
  assert.equal(att.replaceExtension('IMG_001.HEIC', 'image/webp'), 'IMG_001.webp');
  assert.equal(att.replaceExtension('photo', 'image/jpeg'), 'photo.jpg');
  assert.equal(att.replaceExtension('doc.pdf', 'application/pdf'), 'doc.pdf');
});

test('storagePathFromDownloadUrl: 從 download URL 反推物件路徑，解析不出來回空字串', () => {
  assert.equal(att.storagePathFromDownloadUrl(url('tx-receipts/u/t/receipt.webp')), 'tx-receipts/u/t/receipt.webp');
  assert.equal(att.storagePathFromDownloadUrl('https://example.com/a.jpg'), '');
  assert.equal(att.storagePathFromDownloadUrl('https://x/o/%E0%A4%A?x'), '', '壞掉的 percent-encoding 不丟例外');
});

test('decodeAttachments: 舊 photoUrl 映射成 attachments[0]；有 attachments 時以它為準', () => {
  const created = new Date('2026-05-01T00:00:00Z');
  const legacy = att.decodeAttachments(undefined, url('tx-receipts/u/t/photo-1.webp'), created);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].url, url('tx-receipts/u/t/photo-1.webp'));
  assert.equal(legacy[0].path, 'tx-receipts/u/t/photo-1.webp');
  assert.equal(legacy[0].contentType, 'image/webp');
  assert.equal(legacy[0].uploadedAt, created);

  assert.deepEqual(att.decodeAttachments(undefined, undefined, created), []);
  assert.deepEqual(att.decodeAttachments([], '', created), []);

  // Firestore Timestamp（有 toDate）/ Date / 字串都吃；壞元素略過；超過 5 個截斷
  const ts = { toDate: () => new Date('2026-06-01T00:00:00Z') };
  const rows = att.decodeAttachments([
    { url: 'u1', path: 'p1', name: 'a.webp', contentType: 'image/webp', size: 1000, uploadedAt: ts },
    { url: 'u2', name: 'b.pdf', contentType: 'application/pdf', size: 2000, uploadedAt: '2026-06-02T00:00:00Z' },
    null,
    { path: 'no-url' },
    { url: 'u3' }, { url: 'u4' }, { url: 'u5' }, { url: 'u6' },
  ], 'legacy-should-be-ignored', created);
  assert.deepEqual(rows.map((r) => r.url), ['u1', 'u2', 'u3', 'u4', 'u5']);
  assert.equal(rows[0].uploadedAt.toISOString(), '2026-06-01T00:00:00.000Z');
  assert.equal(rows[1].uploadedAt.toISOString(), '2026-06-02T00:00:00.000Z');
  assert.equal(rows[1].path, '', '沒有 path 又不是 Storage URL');
  assert.equal(rows[2].contentType, 'application/octet-stream');
  assert.equal(rows[2].uploadedAt, created);
});

test('legacyPhotoUrlFor / sameAttachments / removedAttachments', () => {
  const pdf = { url: 'pdf', path: 'p', name: 'a.pdf', contentType: 'application/pdf', size: 1, uploadedAt: new Date() };
  const img1 = { ...pdf, url: 'img1', contentType: 'image/webp' };
  const img2 = { ...pdf, url: 'img2', contentType: 'image/jpeg' };
  assert.equal(att.legacyPhotoUrlFor([pdf, img1, img2]), 'img1', '第一張圖片，PDF 跳過');
  assert.equal(att.legacyPhotoUrlFor([pdf]), null);
  assert.equal(att.legacyPhotoUrlFor([]), null);

  assert.equal(att.sameAttachments([img1, pdf], [{ ...img1 }, { ...pdf }]), true);
  assert.equal(att.sameAttachments([img1, pdf], [pdf, img1]), false, '順序不同要寫回（photoUrl 可能變）');
  assert.equal(att.sameAttachments(undefined, []), true);
  assert.equal(att.sameAttachments([img1], []), false);

  assert.deepEqual(att.removedAttachments([img1, pdf, img2], [img2]).map((a) => a.url), ['img1', 'pdf']);
  assert.deepEqual(att.removedAttachments(undefined, [img1]), []);
});

test('formatAttachmentSize', () => {
  assert.equal(att.formatAttachmentSize(0), '');
  assert.equal(att.formatAttachmentSize(512), '512 B');
  assert.equal(att.formatAttachmentSize(300 * 1024), '300 KB');
  assert.equal(att.formatAttachmentSize(2.5 * MB), '2.5 MB');
});
