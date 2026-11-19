import type { LucideIcon } from 'lucide-react';
import {
  CandlestickChart, Home, Inbox, Wallet, Plane, PlaneTakeoff, Radar, TrendingUp, DollarSign, Settings, UserCog, Landmark, CalendarRange, HeartHandshake, Sparkles,
} from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  group: 'main' | 'markets' | 'system';
  adminOnly?: boolean;
  /** member（共同帳本成員）也看得到；沒標的項目只給 owner */
  memberVisible?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { label: '首頁', to: '/', icon: Home, group: 'main' },
  { label: '需要處理', to: '/inbox', icon: Inbox, group: 'main' },
  { label: '記帳', to: '/ledger', icon: Wallet, group: 'main' },
  { label: '共同', to: '/shared', icon: HeartHandshake, group: 'main', memberVisible: true },
  { label: '出遊', to: '/trips', icon: Plane, group: 'main', memberVisible: true },
  { label: '機票雷達', to: '/flights', icon: PlaneTakeoff, group: 'main', memberVisible: true },
  { label: '投資', to: '/investments', icon: TrendingUp, group: 'markets' },
  { label: '股市雷達', to: '/stock-radar', icon: Radar, group: 'markets' },
  { label: '台指期模擬', to: '/taifex', icon: CandlestickChart, group: 'markets' },
  { label: '匯率', to: '/fx', icon: DollarSign, group: 'markets' },
  { label: '淨值', to: '/net-worth', icon: Landmark, group: 'markets' },
  { label: '年度回顧', to: '/review', icon: CalendarRange, group: 'markets' },
  { label: 'AI 分析', to: '/ai', icon: Sparkles, group: 'markets' },
  { label: '設定', to: '/settings', icon: Settings, group: 'system', memberVisible: true },
  { label: '管理員', to: '/admin', icon: UserCog, group: 'system', adminOnly: true },
];

/** member 模式的側欄：只留共同 / 出遊 / 機票雷達 / 設定 */
export function navItemsFor(role: { isAdmin: boolean; isMember: boolean }): NavItem[] {
  return NAV_ITEMS.filter((i) => (!i.adminOnly || role.isAdmin) && (!role.isMember || i.memberVisible));
}

/**
 * 手機底部分頁（owner）：最常用的 4 個 + 「更多」。
 * 其他頁面不用在這裡列 —— 「更多」面板會自動列出 navItemsFor() 裡不在底部分頁的項目，
 * 新增頁面只要加進 NAV_ITEMS 就會出現在側欄與「更多」。
 */
export const MOBILE_TABS: NavItem[] = [
  { label: '首頁', to: '/', icon: Home, group: 'main' },
  { label: '記帳', to: '/ledger', icon: Wallet, group: 'main' },
  { label: '共同', to: '/shared', icon: HeartHandshake, group: 'main' },
  { label: '投資', to: '/investments', icon: TrendingUp, group: 'markets' },
];

/** member 模式的底部分頁（項目少，不需要「更多」） */
export const MEMBER_MOBILE_TABS: NavItem[] = [
  { label: '共同', to: '/shared', icon: HeartHandshake, group: 'main' },
  { label: '出遊', to: '/trips', icon: Plane, group: 'main' },
  { label: '機票雷達', to: '/flights', icon: PlaneTakeoff, group: 'main' },
  { label: '設定', to: '/settings', icon: Settings, group: 'system' },
];

/** 「更多」面板的項目：可見項目扣掉已經在底部分頁的 */
export function moreNavItemsFor(role: { isAdmin: boolean; isMember: boolean }, tabs: NavItem[]): NavItem[] {
  const inTabs = new Set(tabs.map((t) => t.to));
  return navItemsFor(role).filter((i) => !inTabs.has(i.to));
}

/** 目前路徑是否屬於某個 nav 項目（'/' 只比對完全相同） */
export function isNavActive(item: Pick<NavItem, 'to'>, pathname: string): boolean {
  if (item.to === '/') return pathname === '/';
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

export const GROUP_LABELS: Record<NavItem['group'], string> = {
  main: 'MAIN',
  markets: 'MARKETS',
  system: 'SYSTEM',
};
