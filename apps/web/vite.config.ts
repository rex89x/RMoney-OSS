import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 與 functions/index.js 的 REGION 一致 */
const MCP_GATEWAY_REGION = 'asia-east1';

/**
 * MCP 閘道的 OAuth authorization server metadata（RFC 8414）。
 * issuer 是 Hosting 網域，所以 `/.well-known/oauth-authorization-server` 由 Hosting 提供靜態 JSON
 * （firebase.json rewrite → /mcp-oauth/authorization-server.json），內容直接用 functions/lib/gateway.js 產生，
 * 確保與閘道實際的端點一致。沒有 project id（例如本機未設定 env）就不產生。
 */
function mcpOAuthMetadata(projectId: string | undefined): Plugin {
  return {
    name: 'mcp-oauth-metadata',
    apply: 'build',
    async generateBundle() {
      if (!projectId) return;
      const file = pathToFileURL(path.resolve(__dirname, '../../functions/lib/gateway.js')).href;
      const mod = (await import(/* @vite-ignore */ file)) as {
        createGateway: (deps: { config: { issuer: string; resourceUrl: string; webOrigins: string[] } }) => {
          authorizationServerMetadata: () => Record<string, unknown>;
        };
      };
      const issuer = `https://${projectId}.web.app`;
      const gateway = mod.createGateway({
        config: { issuer, resourceUrl: `https://${MCP_GATEWAY_REGION}-${projectId}.cloudfunctions.net/mcp`, webOrigins: [issuer] },
      });
      this.emitFile({
        type: 'asset',
        fileName: 'mcp-oauth/authorization-server.json',
        source: JSON.stringify(gateway.authorizationServerMetadata()),
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    mcpOAuthMetadata(loadEnv(mode, __dirname, 'VITE_').VITE_FIREBASE_PROJECT_ID),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'robots.txt', 'icons/*.png'],
      manifest: {
        name: 'Personal Hub',
        short_name: 'Hub',
        description: 'Personal finance + travel planning hub',
        theme_color: '#0a0a0a',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        lang: 'zh-Hant',
        // 長按 app icon 的捷徑（Android / iOS 16.4+ PWA）
        shortcuts: [
          { name: '快速記帳', short_name: '記帳', url: '/?quickEntry=expense', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
          { name: '記一筆收入', short_name: '收入', url: '/?quickEntry=income', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
          { name: '需要處理', short_name: '待辦', url: '/inbox', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
          { name: '共同帳本', short_name: '共同', url: '/shared', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
          { name: '投資', short_name: '投資', url: '/investments', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
        ],
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webp,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/__/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          // 不快取 firestore.googleapis.com：Firestore SDK 用 WebChannel long-poll，SW 回舊回應會讓 SDK 狀態錯亂；
          // 離線讀取已由 SDK 的 persistentLocalCache（IndexedDB）處理（2026-11 稽核 O6）
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    // hidden：照樣產生 .map 供除錯，但 bundle 不帶 sourceMappingURL；firebase.json 也不部署 *.map（稽核 O7）
    sourcemap: 'hidden',
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // storage 只有上傳時才 dynamic import，獨立 chunk 才不會被拉進首屏的 firebase chunk
            if (id.includes('@firebase/storage') || id.includes('firebase/storage')) return 'firebase-storage';
            if (id.includes('firebase')) return 'firebase';
            // markdown 全家只有問一下 / 旅程筆記用到
            if (/[\\/](react-markdown|remark-|rehype-|micromark|mdast-|hast-|unified|unist-|vfile|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities|ccount|markdown-table|longest-streak|zwitch|trim-lines|bail|trough|devlop|is-plain-obj|html-url-attributes|estree-util)/.test(id)) return 'markdown';
            if (id.includes('react-day-picker')) return 'daypicker';
            // recharts 也依賴的小工具：全站都用（clsx 等），不能落在 charts chunk，否則首屏會連帶預載整個圖表庫
            if (/[\\/]node_modules[\\/](clsx|react-is|prop-types|tiny-invariant)[\\/]/.test(id)) return 'react-core';
            if (id.includes('recharts') || id.includes('d3-')) return 'charts';
            if (id.includes('@tanstack')) return 'tanstack';
            if (id.includes('date-fns')) return 'date-fns';
            if (id.includes('@radix-ui') || id.includes('lucide-react') || id.includes('cmdk')) return 'ui';
            if (id.includes('@dnd-kit')) return 'dnd';
            if (id.includes('react-dom') || id.includes('react-router')) return 'react-core';
          }
        },
      },
    },
  },
}));
