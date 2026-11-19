# PWA Icons

請放置以下圖檔：

- `icon-192.png` — 192×192
- `icon-512.png` — 512×512

可以用 https://realfavicongenerator.net 或 `pwa-asset-generator` 從 `apps/web/public/favicon.svg` 產生：

```bash
npx pwa-asset-generator apps/web/public/favicon.svg apps/web/public/icons \
  --icon-only --favicon --opaque false
```

Icon 未提供時 PWA 仍可安裝，但系統通知/啟動畫面的圖會使用 fallback。
