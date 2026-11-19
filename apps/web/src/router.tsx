import { Suspense } from 'react';
import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { AppLayout } from '@/components/layout/app-layout';
import { ProtectedRoute } from '@/components/layout/protected-route';
import { AuthLoading } from '@/components/layout/auth-loading';
import { ErrorBoundary } from '@/components/error-boundary';
import { lazyWithRetry } from '@/lib/lazy-with-retry';

const DashboardPage = lazyWithRetry(() => import('@/pages/dashboard-page'));
const LedgerPage = lazyWithRetry(() => import('@/pages/ledger-page'));
const InboxPage = lazyWithRetry(() => import('@/pages/inbox-page'));
const SharedPage = lazyWithRetry(() => import('@/pages/shared-page'));
const ReviewPage = lazyWithRetry(() => import('@/pages/review-page'));
const AiAnalysisPage = lazyWithRetry(() => import('@/pages/ai-analysis-page'));
const InvestmentsPage = lazyWithRetry(() => import('@/pages/investments-page'));
const StockDetailPage = lazyWithRetry(() => import('@/pages/stock-detail-page'));
const FxPage = lazyWithRetry(() => import('@/pages/fx-page'));
const TripsPage = lazyWithRetry(() => import('@/pages/trips-page'));
const FlightWatchesPage = lazyWithRetry(() => import('@/pages/flight-watches-page'));
const StockRadarPage = lazyWithRetry(() => import('@/pages/stock-radar-page'));
const TaifexPage = lazyWithRetry(() => import('@/pages/taifex-page'));
const TripDetailPage = lazyWithRetry(() => import('@/pages/trip-detail-page'));
const ItineraryPage = lazyWithRetry(() => import('@/pages/itinerary-page'));
const TripNotesPage = lazyWithRetry(() => import('@/pages/trip-notes-page'));
const SettingsPage = lazyWithRetry(() => import('@/pages/settings-page'));
const NetWorthPage = lazyWithRetry(async () => {
  const m = await import('@/features/net-worth');
  return { default: m.NetWorthPage };
});
const AdminPage = lazyWithRetry(() => import('@/features/admin/admin-page'));
const LoginPage = lazyWithRetry(() => import('@/pages/login-page'));
const OAuthAuthorizePage = lazyWithRetry(() => import('@/pages/oauth-authorize-page'));
const NotFoundPage = lazyWithRetry(() => import('@/pages/not-found-page'));

function Page({ scope, children }: { scope: string; children: React.ReactNode }) {
  return (
    <ErrorBoundary scope={scope}>
      <Suspense fallback={<AuthLoading message="載入頁面…" />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

function ProtectedShell() {
  return (
    <ProtectedRoute>
      <AppLayout>
        <Outlet />
      </AppLayout>
    </ProtectedRoute>
  );
}

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <Page scope="Login"><LoginPage /></Page>,
  },
  {
    path: '/oauth/authorize',
    element: <Page scope="OAuthAuthorize"><OAuthAuthorizePage /></Page>,
  },
  {
    element: <ProtectedShell />,
    children: [
      { path: '/', element: <Page scope="Dashboard"><DashboardPage /></Page> },
      { path: '/dashboard', element: <Navigate to="/" replace /> },
      { path: '/inbox', element: <Page scope="Inbox"><InboxPage /></Page> },
      { path: '/shared', element: <Page scope="Shared"><SharedPage /></Page> },
      { path: '/ledger', element: <Page scope="Ledger"><LedgerPage /></Page> },
      { path: '/ledger/dashboard', element: <Navigate to="/ledger" replace /> },
      { path: '/ledger/categories', element: <Navigate to="/settings" replace /> },
      { path: '/ledger/budget', element: <Navigate to="/settings" replace /> },
      { path: '/investments', element: <Page scope="Investments"><InvestmentsPage /></Page> },
      { path: '/investments/:symbol', element: <Page scope="StockDetail"><StockDetailPage /></Page> },
      { path: '/stock-radar', element: <Page scope="StockRadar"><StockRadarPage /></Page> },
      { path: '/taifex', element: <Page scope="Taifex"><TaifexPage /></Page> },
      { path: '/fx', element: <Page scope="FX"><FxPage /></Page> },
      { path: '/trips', element: <Page scope="Trips"><TripsPage /></Page> },
      { path: '/flights', element: <Page scope="FlightWatches"><FlightWatchesPage /></Page> },
      { path: '/trips/:id', element: <Page scope="TripDetail"><TripDetailPage /></Page> },
      { path: '/trips/:id/itinerary', element: <Page scope="Itinerary"><ItineraryPage /></Page> },
      { path: '/trips/:id/notes', element: <Page scope="TripNotes"><TripNotesPage /></Page> },
      { path: '/settings', element: <Page scope="Settings"><SettingsPage /></Page> },
      { path: '/net-worth', element: <Page scope="NetWorth"><NetWorthPage /></Page> },
      { path: '/review', element: <Page scope="Review"><ReviewPage /></Page> },
      { path: '/ai', element: <Page scope="AiAnalysis"><AiAnalysisPage /></Page> },
      { path: '/admin', element: <Page scope="Admin"><AdminPage /></Page> },
      { path: '*', element: <Page scope="NotFound"><NotFoundPage /></Page> },
    ],
  },
]);
