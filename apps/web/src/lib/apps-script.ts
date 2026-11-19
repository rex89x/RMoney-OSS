import { env } from './env';
import { auth } from './firebase';

export type AppsScriptAction =
  | 'ping'
  | 'updateStockPrices'
  | 'refreshSymbol'
  | 'updateStockHistory'
  | 'updateFxRates'
  | 'checkAlerts'
  | 'generateItinerary'
  | 'parseItineraryText'
  | 'geocode'
  | 'placesSearch'
  | 'placeDetails'
  | 'exportData'
  | 'runRecurring'
  | 'runInstallments'
  | 'dailySummary'
  | 'sendTest'
  | 'backfillCandles'
  | 'updateDailyCandles'
  | 'notify'
  | 'suggestDayItems'
  | 'snapshotPortfolio'
  | 'refreshPortfolioSnapshot'
  | 'snapshotNetWorth'
  | 'runSwingScan'
  | 'syncSwingPaperTrades'
  | 'runStockRadar'
  | 'runStockRadarBacktest'
  | 'syncStockRadarFlows'
  | 'importStockSentiment'
  | 'getStockIngestStatus'
  | 'setStockIngestToken'
  | 'revokeStockIngestToken'
  | 'runTaifexDaily'
  | 'backfillTaifex'
  | 'runTaifexBacktest'
  | 'placeTaifexOrder'
  | 'cancelTaifexOrder'
  | 'resetTaifexPaper'
  | 'resumeTaifexPaper'
  | 'importTaifexSentiment'
  | 'getTaifexIngestStatus'
  | 'setTaifexIngestToken'
  | 'revokeTaifexIngestToken'
  | 'diagTaifex'
  | 'runTaifexIntraday'
  | 'runTaifexOptimization'
  | 'diagTaifexQuote'
  | 'runTaifexTech'
  | 'resetTaifexTech'
  | 'refreshTaifexCalendar'
  | 'applyTaifexReview'
  | 'rejectTaifexReview'
  | 'revertTaifexTuning'
  | 'resolveGoogleMapsUrl'
  | 'generateTripNotes'
  | 'refreshFlightWatch'
  | 'importFlightPrices'
  | 'getFlightIngestStatus'
  | 'setFlightIngestToken'
  | 'revokeFlightIngestToken'
  | 'syncTripDocument'
  | 'inviteTripUser'
  | 'acceptPendingInvites'
  | 'updateDividendCalendar'
  | 'setupTriggers'
  | 'askFinance'
  | 'getAiUsageSummary'
  | 'estimateClaudeAnalysis'
  | 'runClaudeAnalysis'
  | 'getMcpStatus'
  | 'setMcpToken'
  | 'revokeMcpToken'
  | 'setMcpWriteAccess'
  | 'syncEInvoices'
  | 'parseReceipt'
  | 'parseImport'
  | 'inviteHouseholdMember'
  | 'joinHousehold'
  | 'checkAccess'
  | 'createTelegramLink'
  | 'unlinkTelegram'
  | 'sendHouseholdReport'
  | 'refreshHouseholdQuotes';

export interface AppsScriptResponse<T = unknown> {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
  result?: T;
}

async function getIdToken(): Promise<string | null> {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken();
}

export async function callAppsScript<T = unknown>(
  action: AppsScriptAction,
  params?: Record<string, string>,
  body?: unknown,
): Promise<AppsScriptResponse<T>> {
  if (!env.appsScriptUrl) {
    throw new Error('VITE_APPS_SCRIPT_URL 未設定');
  }
  const idToken = await getIdToken();
  const url = new URL(env.appsScriptUrl);
  url.searchParams.set('action', action);
  const payload =
    body && typeof body === 'object'
      ? { ...params, ...(body as Record<string, unknown>), idToken }
      : { ...params, idToken };
  const init: RequestInit = {
    method: 'POST',
    // Apps Script CORS workaround: use text/plain to avoid preflight
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  };

  const resp = await fetch(url.toString(), init);
  if (!resp.ok) {
    throw new Error(`Apps Script HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as AppsScriptResponse<T> & { reason?: string };
  if (data && data.ok === false) {
    throw new Error(data.error ?? data.reason ?? 'Apps Script error');
  }
  return data;
}
