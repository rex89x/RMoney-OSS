import { NavLink } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { GROUP_LABELS, navItemsFor, type NavItem } from './nav-items';
import { useAuth, signOutAndClear } from '@/hooks/use-auth';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { NotificationBell } from '@/features/notifications/components/notification-bell';

function groupItems(items: NavItem[]) {
  const groups: Record<string, NavItem[]> = { main: [], markets: [], system: [] };
  for (const item of items) groups[item.group]?.push(item);
  return groups;
}

export function Sidebar() {
  const { profile, user, isAdmin, isMember } = useAuth();
  const grouped = groupItems(navItemsFor({ isAdmin, isMember }));

  const displayName = profile?.displayName ?? user?.displayName ?? user?.email ?? 'User';
  const initials = (displayName ?? 'U').slice(0, 1).toUpperCase();

  return (
    <aside className="hidden h-screen w-60 shrink-0 flex-col border-r bg-card lg:flex">
      <div className="flex h-12 items-center justify-between gap-2 border-b pl-4 pr-2 font-semibold">
        <span className="text-base">Personal Hub</span>
        <NotificationBell />
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        {(['main', 'markets', 'system'] as const).filter((g) => (grouped[g]?.length ?? 0) > 0).map((g) => (
          <div key={g}>
            <div className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground">
              {GROUP_LABELS[g]}
            </div>
            <ul className="space-y-0.5">
              {grouped[g]?.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex h-10 items-center gap-3 rounded-md px-3 text-sm transition-colors',
                        isActive
                          ? 'bg-primary/10 text-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive ? (
                          <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
                        ) : null}
                        <item.icon className={cn('size-5', isActive ? 'text-primary' : '')} />
                        <span className="font-medium">{item.label}</span>
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="flex items-center justify-between gap-2 border-t p-3">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar className="h-8 w-8">
            {profile?.photoURL ? <AvatarImage src={profile.photoURL} alt={displayName ?? ''} /> : null}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{displayName}</div>
            <div className="truncate text-xs text-muted-foreground">{profile?.email}</div>
          </div>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => void signOutAndClear()}
          aria-label="Logout"
        >
          <LogOut className="size-4" />
        </Button>
      </div>
    </aside>
  );
}
