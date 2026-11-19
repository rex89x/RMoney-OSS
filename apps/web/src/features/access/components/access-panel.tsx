import { Link } from 'react-router-dom';
import { HeartHandshake } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { useHousehold } from '@/features/household/hooks';
import { MemberChip } from '@/features/household/components/member-chip';
import { WhitelistPanel } from './whitelist-panel';
import { UsersPanel } from './users-panel';
import { AccessDiagnostics } from './access-diagnostics';

/** 權限管理總面板（admin）：疑難排解 → 白名單 → 使用者角色 → 共同帳本成員 */
export function AccessPanel() {
  const { isAdmin } = useAuth();
  const { household } = useHousehold();
  if (!isAdmin) {
    return <p className="text-sm text-muted-foreground">此頁僅限管理員（admin）。</p>;
  }
  return (
    <div className="space-y-4">
      <AccessDiagnostics />
      <div className="grid gap-4 md:grid-cols-2">
        <WhitelistPanel docId="allowedEmails" />
        <WhitelistPanel docId="guestEmails" />
      </div>
      <UsersPanel />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><HeartHandshake className="size-4" /> 共同帳本成員與權限</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {household ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {household.memberIds.map((id) => <MemberChip key={id} member={household.members[id]} />)}
                {household.pendingInvites.map((e) => <span key={e} className="text-xs text-muted-foreground">待加入：{e}</span>)}
              </div>
              <p className="text-xs text-muted-foreground">
                邀請連結、每位成員能做什麼（新增支出 / 結算 / 目標 / 改設定）、移除成員，都在共同帳本的設定分頁。
              </p>
              <Button asChild variant="outline" size="sm"><Link to="/shared?tab=settings">前往共同帳本設定</Link></Button>
            </>
          ) : (
            <>
              <p className="text-muted-foreground">還沒建立共同帳本。</p>
              <Button asChild variant="outline" size="sm"><Link to="/shared">前往建立</Link></Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
