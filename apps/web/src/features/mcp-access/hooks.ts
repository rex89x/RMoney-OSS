import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import {
  approveOAuth, buildDenyRedirect, fetchOAuthClient, getMcpStatus, listMcpGrants, mcpGatewayUrl,
  revokeMcpGrant, revokeMcpToken, rotateMcpToken, setMcpGrantWrite, setMcpWriteAccess,
} from './api';
import { OAuthAuthorizeParamsSchema } from './schema';
import type { McpIssuedToken } from './types';

const STATUS_KEY = ['mcp-status'];
const GRANTS_KEY = ['mcp-grants'];

export function useMcpStatus() {
  return useQuery({ queryKey: STATUS_KEY, queryFn: getMcpStatus });
}

export function useRotateMcpToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: rotateMcpToken,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      toast.success('已產生新的 MCP token，舊 token 已失效');
    },
    onError: (error) => {
      console.error('[rotateMcpToken]', error);
      toast.error(error instanceof Error ? error.message : '產生 token 失敗');
    },
  });
}

export function useRevokeMcpToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeMcpToken,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      toast.success('已撤銷 MCP token，bridge 無法再讀取資料');
    },
    onError: (error) => {
      console.error('[revokeMcpToken]', error);
      toast.error(error instanceof Error ? error.message : '撤銷失敗');
    },
  });
}

/** 已核准的 OAuth 授權（Claude.ai 等）。閘道尚未部署時會失敗，不重試、由 UI 顯示提示。 */
export function useMcpGrants() {
  return useQuery({ queryKey: GRANTS_KEY, queryFn: listMcpGrants, retry: false, staleTime: 60_000 });
}

export function useRevokeMcpGrant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeMcpGrant,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: GRANTS_KEY });
      toast.success('已撤銷授權，該 client 立即無法再讀取資料');
    },
    onError: (error) => {
      console.error('[revokeMcpGrant]', error);
      toast.error(error instanceof Error ? error.message : '撤銷失敗');
    },
  });
}

export function useSetMcpGrantWrite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setMcpGrantWrite,
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: GRANTS_KEY });
      toast.success(input.write ? '已允許寫入（記帳、股票成交、行程）' : '已改回唯讀');
    },
    onError: (error) => {
      console.error('[setMcpGrantWrite]', error);
      toast.error(error instanceof Error ? error.message : '更新失敗');
    },
  });
}

export function useSetMcpWriteAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setMcpWriteAccess,
    onSuccess: (_data, enabled) => {
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      toast.success(enabled ? 'bridge token 已允許寫入' : 'bridge token 已改回唯讀');
    },
    onError: (error) => {
      console.error('[setMcpWriteAccess]', error);
      toast.error(error instanceof Error ? error.message : '更新失敗');
    },
  });
}

/** MCP 連線卡片的流程：bridge token（產生 / 撤銷，只留在記憶體）、OAuth 授權清單、複製 */
export function useMcpAccess() {
  const status = useMcpStatus();
  const rotate = useRotateMcpToken();
  const revoke = useRevokeMcpToken();
  const grants = useMcpGrants();
  const revokeGrant = useRevokeMcpGrant();
  const grantWrite = useSetMcpGrantWrite();
  const bridgeWrite = useSetMcpWriteAccess();
  const [issued, setIssued] = useState<McpIssuedToken | null>(null);

  async function generate() {
    try {
      setIssued(await rotate.mutateAsync());
    } catch {
      // 錯誤已由 useRotateMcpToken toast
    }
  }

  async function remove() {
    try {
      await revoke.mutateAsync();
      setIssued(null);
    } catch {
      // 錯誤已由 useRevokeMcpToken toast
    }
  }

  async function removeGrant(grantId: string) {
    try {
      await revokeGrant.mutateAsync(grantId);
    } catch {
      // 錯誤已由 useRevokeMcpGrant toast
    }
  }

  async function setGrantWrite(grantId: string, write: boolean) {
    try {
      await grantWrite.mutateAsync({ grantId, write });
    } catch {
      // 錯誤已由 useSetMcpGrantWrite toast
    }
  }

  async function setBridgeWrite(enabled: boolean) {
    try {
      await bridgeWrite.mutateAsync(enabled);
    } catch {
      // 錯誤已由 useSetMcpWriteAccess toast
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已複製${label}`);
    } catch (err) {
      console.error('[copyMcp]', err);
      toast.error('複製失敗');
    }
  }

  return {
    gatewayUrl: mcpGatewayUrl(),
    status: status.data ?? null,
    statusLoading: status.isLoading,
    statusError: status.isError,
    grants: grants.data ?? [],
    grantsLoading: grants.isLoading,
    grantsError: grants.isError,
    issued,
    busy: rotate.isPending || revoke.isPending,
    revokingGrant: revokeGrant.isPending,
    updatingWrite: grantWrite.isPending || bridgeWrite.isPending,
    generate,
    remove,
    removeGrant,
    setGrantWrite,
    setBridgeWrite,
    copy,
  };
}

/**
 * OAuth 授權頁（/oauth/authorize）的流程：解析參數 → 等登入 → 請閘道驗證 client → 使用者允許 / 拒絕。
 * 只有 owner / admin 能允許；閘道會再驗一次 ID token 與角色，前端的判斷只是為了體驗。
 */
export function useOAuthConsent() {
  const [searchParams] = useSearchParams();
  const { status, isOwner } = useAuth();
  const parsed = useMemo(
    () => OAuthAuthorizeParamsSchema.safeParse(Object.fromEntries(searchParams.entries())),
    [searchParams],
  );
  const params = parsed.success ? parsed.data : null;
  // 預設唯讀；要讓 AI 幫忙記帳 / 匯入行程，owner 必須在同意畫面明確打開
  const [allowWrite, setAllowWrite] = useState(false);
  const canAsk = status === 'authed' && isOwner && params !== null;

  const client = useQuery({
    queryKey: ['mcp-oauth-client', params],
    queryFn: () => {
      if (!params) throw new Error('授權請求的參數不正確');
      return fetchOAuthClient(params);
    },
    enabled: canAsk,
    retry: false,
    staleTime: Infinity,
  });

  const approve = useMutation({
    mutationFn: approveOAuth,
    onSuccess: (redirectTo) => window.location.assign(redirectTo),
    onError: (error) => {
      console.error('[approveOAuth]', error);
      toast.error(error instanceof Error ? error.message : '授權失敗');
    },
  });

  return {
    authStatus: status,
    isOwner,
    paramsValid: params !== null,
    client: client.data ?? null,
    clientLoading: canAsk && client.isLoading,
    clientError: client.error instanceof Error ? client.error.message : null,
    approving: approve.isPending || approve.isSuccess,
    allowWrite,
    setAllowWrite,
    allow: () => { if (params && client.data) approve.mutate({ params, allowWrite }); },
    // 只有閘道確認過 redirect_uri 屬於這個 client 之後才導回去
    deny: () => { if (params && client.data) window.location.assign(buildDenyRedirect(params)); },
  };
}
