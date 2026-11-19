export interface McpStatus {
  configured: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
  toolCount: number;
  dailyLimit: number;
  /** bridge token 能不能寫入（記帳 / 股票成交 / 行程）；預設 false，換 token 會重設 */
  writeEnabled: boolean;
  writeToolCount: number;
  dailyWriteLimit: number;
}

/** 剛產生的 bridge token：明文只存在這次的畫面狀態，重新整理就看不到了 */
export interface McpIssuedToken {
  token: string;
  /** Claude Code 加入 stdio bridge 的指令 */
  claudeCodeCommand: string;
}

/** Claude.ai 等 client 經 OAuth 核准後的一筆授權（存在閘道，見 functions/） */
export interface McpGrant {
  grantId: string;
  clientName: string;
  /** owner 是否允許這個 client 寫入；可在卡片上隨時切換 */
  write: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

/** 授權頁收到的 OAuth 參數（原樣轉給閘道驗證） */
export interface OAuthAuthorizeParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  state?: string;
  scope?: string;
  resource?: string;
}

export interface OAuthClientInfo {
  clientName: string;
  redirectHost: string;
}
