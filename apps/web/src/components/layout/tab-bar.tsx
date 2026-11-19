import { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { LayoutGrid, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle,
} from '@/components/ui/drawer';
import { useAuth } from '@/hooks/use-auth';
import { NotificationBell, UnreadBadge } from '@/features/notifications/components/notification-bell';
import { useUnreadNotificationCount } from '@/features/notifications/hooks';
import { formatUnreadBadge } from '@/features/notifications/utils';
import {
  GROUP_LABELS, MEMBER_MOBILE_TABS, MOBILE_TABS, isNavActive, moreNavItemsFor, type NavItem,
} from './nav-items';

function haptic() {
  if ('vibrate' in navigator) navigator.vibrate?.(10);
}

function TabLabel({ icon: Icon, label, active, badge }: { icon: LucideIcon; label: string; active: boolean; badge?: string }) {
  return (
    <span
      className={cn(
        'relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
        active ? 'text-primary' : 'text-muted-foreground',
      )}
    >
      {active ? <span className="absolute left-1/2 top-0 h-[3px] w-10 -translate-x-1/2 rounded-b-full bg-primary" /> : null}
      <span className="relative">
        <Icon className={cn('size-6 transition-transform', active ? 'stroke-[2.5] scale-110' : 'stroke-2')} aria-hidden />
        {badge ? <UnreadBadge text={badge} className="absolute -right-2.5 -top-1" /> : null}
      </span>
      <span className={cn(active && 'font-semibold')}>{label}</span>
    </span>
  );
}

export function TabBar() {
  const { isMember, isAdmin } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  // App 內通知未讀數（owner-only；member 沒有「更多」）。手機沒有側欄，徽章掛在「更多」上，
  // 「更多」面板標題列有鈴鐺可開通知中心。
  const unread = useUnreadNotificationCount();
  const tabs = isMember ? MEMBER_MOBILE_TABS : MOBILE_TABS;
  const more = isMember ? [] : moreNavItemsFor({ isAdmin, isMember }, tabs);
  const moreActive = more.some((item) => isNavActive(item, pathname));

  const grouped = (['main', 'markets', 'system'] as const)
    .map((g) => ({ group: g, items: more.filter((i) => i.group === g) }))
    .filter((g) => g.items.length > 0);

  function go(item: NavItem) {
    haptic();
    setMoreOpen(false);
    navigate(item.to);
  }

  return (
    <>
      <nav
        // select-none + 關掉 touch-callout：長按分頁不要跳出 iOS 連結預覽 / 「在新分頁開啟」
        className="fixed inset-x-0 bottom-0 z-40 flex select-none items-stretch border-t bg-card/90 backdrop-blur-lg [-webkit-touch-callout:none] lg:hidden"
        aria-label="Bottom navigation"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {tabs.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className="flex min-w-0 flex-1 items-stretch justify-center"
            onClick={haptic}
          >
            {({ isActive }) => <TabLabel icon={item.icon} label={item.label} active={isActive} />}
          </NavLink>
        ))}
        {more.length > 0 ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-stretch justify-center"
            onClick={() => { haptic(); setMoreOpen(true); }}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-label={unread > 0 ? `更多（${unread} 則未讀通知）` : undefined}
          >
            <TabLabel icon={LayoutGrid} label="更多" active={moreActive} badge={formatUnreadBadge(unread)} />
          </button>
        ) : null}
      </nav>

      {more.length > 0 ? (
        <Drawer open={moreOpen} onOpenChange={setMoreOpen}>
          <DrawerContent className="lg:hidden">
            <DrawerHeader className="flex flex-row items-center justify-between gap-2 text-left">
              <div className="min-w-0">
                <DrawerTitle>所有功能</DrawerTitle>
                <DrawerDescription className="sr-only">選擇要前往的頁面</DrawerDescription>
              </div>
              <NotificationBell onBeforeOpen={() => setMoreOpen(false)} />
            </DrawerHeader>
            <div
              className="min-h-0 space-y-4 overflow-y-auto px-4"
              style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
            >
              {grouped.map(({ group, items }) => (
                <section key={group}>
                  <h3 className="px-1 pb-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground">{GROUP_LABELS[group]}</h3>
                  <ul className="grid grid-cols-4 gap-2">
                    {items.map((item) => {
                      const active = isNavActive(item, pathname);
                      return (
                        <li key={item.to}>
                          <button
                            type="button"
                            onClick={() => go(item)}
                            aria-current={active ? 'page' : undefined}
                            className={cn(
                              'flex h-20 w-full flex-col items-center justify-center gap-1.5 rounded-2xl border text-xs font-medium transition-colors active:scale-95',
                              active ? 'border-primary bg-primary/10 text-primary' : 'bg-card text-foreground hover:bg-muted',
                            )}
                          >
                            <item.icon className="size-6" aria-hidden />
                            <span className="max-w-full truncate px-1">{item.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </DrawerContent>
        </Drawer>
      ) : null}
    </>
  );
}
