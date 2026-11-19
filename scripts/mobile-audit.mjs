#!/usr/bin/env node
/**
 * 手機版版面檢查：用窄螢幕開啟每一頁（並逐一點過頁面上的分頁），找出「超出畫面寬度、又不在可捲動 / 裁切容器裡」的元素，
 * 也就是使用者看不到或必須轉橫向才看得到的內容；同時存整頁截圖。
 *
 * 需要：本機 emulator + seed + `npm run dev:emulator --workspace apps/web`（見 docs/RUNBOOK.md「手機版檢查」）
 *   node scripts/mobile-audit.mjs [email] [path ...]
 *   例：node scripts/mobile-audit.mjs partner@example.com /shared "/shared?tab=invest"
 * 環境變數：APP_URL（預設 http://localhost:5174）、WIDTH（預設 360；建議再跑一次 320）、CHROMIUM_PATH、OUT_DIR（預設 ./mobile-audit）
 * 有溢出、或登入失敗（seed 沒跑 / 白名單不符）時 exit code 非 0，可以接在 CI 或 pre-push。
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const DEFAULT_PATHS = [
  '/', '/inbox', '/ledger', '/investments', '/investments/2330', '/stock-radar', '/taifex', '/fx',
  '/shared', '/shared?tab=txs', '/shared?tab=invest', '/shared?tab=fund', '/shared?tab=report',
  '/shared?tab=settlements', '/shared?tab=goals', '/shared?tab=settings',
  '/trips', '/trips/trip-tokyo-2026', '/trips/trip-tokyo-2026/itinerary', '/trips/trip-tokyo-2026/notes',
  '/flights', '/net-worth', '/review', '/settings', '/admin',
];

const [, , who = 'rex@example.com', ...rest] = process.argv;
const paths = rest.length ? rest : DEFAULT_PATHS;
const base = process.env.APP_URL ?? 'http://localhost:5174';
const outDir = process.env.OUT_DIR ?? 'mobile-audit';
const width = Number(process.env.WIDTH ?? 360);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({
  viewport: { width, height: 800 }, isMobile: true, hasTouch: true, locale: 'zh-TW', timezoneId: 'Asia/Taipei',
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${base}/login`);
await page.waitForFunction(() => typeof window.__devSignIn === 'function', null, { timeout: 60000 });
await page.evaluate((email) => window.__devSignIn(email), who);
await page.waitForTimeout(2500);
if (new URL(page.url()).pathname.startsWith('/login')) {
  // 沒有這個檢查的話，之後每一頁都會被導回登入頁、全部顯示 ok（測到的其實是登入頁）
  console.error(`登入失敗：${who} 仍停在 /login。先跑 node scripts/seed-emulator.mjs，並確認白名單 seed 與 firestore.rules 一致。`);
  await browser.close();
  process.exit(2);
}

/** 在頁面內執行：回傳超出畫面的元素描述 */
function findOffenders() {
  const vw = document.documentElement.clientWidth;
  const describe = (el) =>
    `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).slice(0, 60)} "${(el.textContent ?? '').trim().slice(0, 24)}"`;
  const reported = new Set();
  const out = [];
  for (const el of document.querySelectorAll('main *')) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue; // 圖表內部節點由 svg 本身代表
    // 純裝飾（光暈、進度條填色）與 Radix 的隱藏 input 不算
    if (el.getAttribute('aria-hidden') === 'true' || (!(el.textContent ?? '').trim() && /pointer-events-none|transition-all/.test(String(el.className)))) continue;
    // 被 overflow auto/scroll/hidden/clip 的祖先包住 = 刻意橫向捲動或裁切，不算
    let contained = false;
    let nested = false;
    for (let n = el.parentElement; n && n.tagName !== 'MAIN'; n = n.parentElement) {
      if (reported.has(n)) nested = true;
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(n).overflowX)) { contained = true; break; }
    }
    if (contained) continue;
    if (r.right > vw + 1 || r.left < -1) {
      reported.add(el);
      if (!nested) out.push(`${describe(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
    }
  }
  return out.slice(0, 10);
}

let failures = 0;
async function check(path, tab) {
  const offenders = await page.evaluate(findOffenders);
  const name = `${who.split('@')[0]}-${width}${path.replace(/[/?=&]/g, '_') || '_home'}${tab ? `__${tab.replace(/[^\p{L}\p{N}]+/gu, '-')}` : ''}`;
  const file = `${outDir}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`${offenders.length ? 'FAIL' : 'ok  '} ${path}${tab ? ` [${tab}]` : ''}  → ${file}`);
  offenders.forEach((o) => console.log('     ', o));
  if (offenders.length) failures += 1;
}

async function clickTab(label) {
  try {
    await page.locator('[role="tab"]', { hasText: label }).first().click({ timeout: 2000 });
    await page.waitForTimeout(1200);
    return true;
  } catch {
    return false; // 分頁被收合 / 已不在畫面上
  }
}

for (const path of paths) {
  await page.goto(base + path);
  await page.waitForTimeout(3000);
  await check(path, '');
  // 逐一點過分頁（含點開後才出現的第二層分頁）
  const tabs = await page.locator('[role="tab"]').allTextContents();
  for (const tab of tabs) {
    if (!(await clickTab(tab))) continue;
    await check(path, tab.trim());
    const nested = (await page.locator('[role="tab"]').allTextContents()).filter((t) => !tabs.includes(t));
    for (const sub of nested) {
      if (await clickTab(sub)) await check(path, `${tab.trim()}>${sub.trim()}`);
    }
  }
}
await browser.close();
process.exit(failures ? 1 : 0);
