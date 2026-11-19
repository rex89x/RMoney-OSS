import { z } from 'zod';

/** `rmcp_` + 32 bytes base64url；與 apps-script/src/Mcp.gs MCP_TOKEN_PATTERN_ 一致 */
export const McpTokenSchema = z.string().regex(/^rmcp_[A-Za-z0-9_-]{43}$/);

export const McpStatusSchema = z.object({
  configured: z.boolean(),
  createdAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  toolCount: z.number(),
  dailyLimit: z.number(),
  writeEnabled: z.boolean(),
  writeToolCount: z.number(),
  dailyWriteLimit: z.number(),
});

export const McpGrantSchema = z.object({
  grantId: z.string(),
  clientName: z.string(),
  // 舊版閘道（尚未部署寫入功能）不會回這個欄位
  write: z.boolean().default(false),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
});

/** 授權頁 query string；格式不對就不顯示同意畫面（細部驗證由閘道再做一次） */
export const OAuthAuthorizeParamsSchema = z.object({
  client_id: z.string().min(1).max(100),
  redirect_uri: z.string().url().max(500),
  response_type: z.literal('code'),
  code_challenge: z.string().regex(/^[A-Za-z0-9\-_]{43}$/),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(1000).optional(),
  scope: z.string().max(200).optional(),
  resource: z.string().max(500).optional(),
});

export const OAuthClientInfoSchema = z.object({
  clientName: z.string(),
  redirectHost: z.string(),
});
