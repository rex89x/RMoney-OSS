import { OAuthConsent } from '@/features/mcp-access';

/** OAuth 授權頁（MCP 閘道的 authorization_endpoint）。不走 ProtectedShell：要保留 query string 並自己處理登入。 */
export default function OAuthAuthorizePage() {
  return <OAuthConsent />;
}
