import {
  Utensils, Car, Home, ShoppingBag, Stethoscope, Gamepad2, BookOpen,
  TrendingUp, Gift, MoreHorizontal, Briefcase, Award, LineChart, Ticket,
  Hotel, Plane, Bus, Coffee, Plus, Plane as PlaneIcon,
  Wallet, DollarSign, Settings, LogOut, Home as HomeIcon, BarChart3,
  CreditCard, PiggyBank, Calendar, MapPin, Camera, HelpCircle, Scale, HandCoins, ShieldCheck, type LucideIcon,
} from 'lucide-react';

export const iconMap: Record<string, LucideIcon> = {
  Utensils, Car, Home, ShoppingBag, Stethoscope, Gamepad2, BookOpen,
  TrendingUp, Gift, MoreHorizontal, Briefcase, Award, LineChart, Ticket,
  Hotel, Plane, Bus, Coffee, Plus, Wallet, DollarSign, Settings, LogOut,
  HomeIcon, BarChart3, CreditCard, PiggyBank, Calendar, MapPin, Camera, Scale, HandCoins, ShieldCheck,
};

export function resolveIcon(name?: string | null): LucideIcon {
  if (!name) return HelpCircle;
  return iconMap[name] ?? HelpCircle;
}

export const CATEGORY_ICON_NAMES = [
  'Utensils', 'Car', 'Home', 'ShoppingBag', 'Stethoscope', 'Gamepad2',
  'BookOpen', 'TrendingUp', 'Gift', 'MoreHorizontal', 'Briefcase',
  'Award', 'LineChart', 'Ticket', 'Hotel', 'Plane', 'Bus', 'Coffee',
  'Wallet', 'CreditCard', 'PiggyBank', 'Camera', 'ShieldCheck',
] as const;

export {
  PlaneIcon, Wallet, DollarSign, Settings, LogOut, HomeIcon, BarChart3,
  TrendingUp, Plus,
};
