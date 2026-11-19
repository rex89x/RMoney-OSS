#!/usr/bin/env node
/**
 * Personal Hub MCP — stdio bridge（零依賴，Node 18+）。
 *
 * Claude Code / Claude Desktop 等 MCP client 以 stdio 啟動這支程式；它把每一則 JSON-RPC 訊息
 * 轉送到 Apps Script 的 `?action=mcp` 端點（apps-script/src/Mcp.gs），再把回應寫回 stdout。
 * Token 放在 POST body（不進 URL）。預設唯讀；要讓 AI 記帳 / 匯入行程，到 App「AI 分析 → MCP 連線」
 * 打開「允許 bridge token 寫入」（重新產生 token 會回到唯讀）。
 *
 * 環境變數：
 *   HUB_MCP_URL    Apps Script Web App URL（https://script.google.com/macros/s/.../exec，同 VITE_APPS_SCRIPT_URL）
 *   HUB_MCP_TOKEN  在 App「AI 分析 → MCP 連線」產生的 token（rmcp_...）
 *
 * Claude Code：
 *   claude mcp add personal-hub -e HUB_MCP_URL=... -e HUB_MCP_TOKEN=rmcp_... -- node scripts/hub-mcp.mjs
 *
 * 自我檢查（不需要 MCP client）：
 *   HUB_MCP_URL=... HUB_MCP_TOKEN=... node scripts/hub-mcp.mjs --check
 */
import { createInterface } from 'node:readline';

const url = process.env.HUB_MCP_URL;
const token = process.env.HUB_MCP_TOKEN;

function log(...args) {
  // stdout 只能放 JSON-RPC；診斷訊息一律走 stderr
  process.stderr.write(`[hub-mcp] ${args.join(' ')}\n`);
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** 轉送一則訊息（或 batch）；notification 沒有回應時回 null */
export async function forward(rpc, { endpoint = url, mcpToken = token, fetchImpl = fetch } = {}) {
  const target = new URL(endpoint);
  target.searchParams.set('action', 'mcp');
  // text/plain：與前端一致，避免 Apps Script 的 CORS / content-type 特例；fetch 會自動跟隨 302 到 googleusercontent
  const resp = await fetchImpl(target, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ mcpToken, rpc }),
    redirect: 'follow',
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Apps Script 出錯時會回 HTML 錯誤頁
    throw new Error('endpoint did not return JSON (check HUB_MCP_URL and that the Web App is deployed)');
  }
}

async function check() {
  const init = await forward({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hub-mcp-check', version: '1' } } });
  if (init?.error) throw new Error(init.error.message);
  const list = await forward({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  if (list?.error) throw new Error(list.error.message);
  const names = (list?.result?.tools ?? []).map((t) => t.name);
  log(`OK — ${init.result.serverInfo.name} (protocol ${init.result.protocolVersion}), ${names.length} tools:`);
  log(names.join(', '));
}

async function main() {
  if (!url || !token) {
    log('missing HUB_MCP_URL or HUB_MCP_TOKEN');
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    try { await check(); } catch (err) { log('check failed:', err.message); process.exit(1); }
    return;
  }
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // 依序處理，回應順序與請求一致
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let rpc;
      try {
        rpc = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`);
        return;
      }
      const isRequest = Array.isArray(rpc) ? rpc.some((m) => m?.id != null) : rpc?.id != null;
      try {
        const response = await forward(rpc);
        if (response !== null && isRequest) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (err) {
        log('forward failed:', err.message);
        if (isRequest) {
          process.stdout.write(`${JSON.stringify(rpcError(Array.isArray(rpc) ? null : rpc.id, -32603, `Personal Hub unreachable: ${err.message}`))}\n`);
        }
      }
    });
  });
  rl.on('close', () => { void queue.then(() => process.exit(0)); });
}

// 只有直接執行時才啟動（測試會 import forward）
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
