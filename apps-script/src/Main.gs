/**
 * Personal Hub — Apps Script Web App entry
 * - doGet / doPost 依 e.parameter.action 分派
 * - 所有 endpoint 先經 authenticate_() 驗證 Firebase ID Token + whitelist
 */

var PROP = PropertiesService.getScriptProperties();

/** role = 'member'（共同帳本伴侶）可以呼叫的 action；每個 handler 內部還會再驗 household 成員身分 */
var MEMBER_ALLOWED_ACTIONS_ = [
  'ping',
  'acceptPendingInvites',
  'createTelegramLink',
  'unlinkTelegram',
  'sendHouseholdReport',
  'refreshHouseholdQuotes',
  // 機票雷達（2026-11 開放給伴侶）：這幾個 action 都以 authResult.uid 比對 watch.userId，只碰自己的訂閱。
  // setFlightIngestToken / revokeFlightIngestToken / getFlightIngestStatus 不開放 —— 推送 token 是整個 Script 共用一把，member 改了會蓋掉 owner 的。
  'refreshFlightWatch',
  'importFlightPrices',
];

function jsonResponse_(obj, statusCode) {
  // Apps Script Web App 不能自訂 status code；但我們把 ok/status 帶在 body 裡
  if (statusCode && statusCode >= 400) {
    obj = Object.assign({ ok: false }, obj);
  }
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function parseBody_(e) {
  try {
    if (e && e.postData && e.postData.contents) {
      return JSON.parse(e.postData.contents);
    }
  } catch (err) {
    console.warn('parseBody failed', err);
  }
  return {};
}

/** 常數時間字串比較（secret 比對用，避免 timing side-channel） */
function secretEquals_(a, b) {
  var x = String(a || '');
  var y = String(b || '');
  if (!x || !y) return false;
  var max = Math.max(x.length, y.length);
  var diff = x.length ^ y.length;
  for (var i = 0; i < max; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * 診斷 / 維運端點（tgDiag、tgFlush、tgInfo、diag）的授權：
 * `?secret=` 要等於 Script Property TG_WEBHOOK_SECRET。這些端點以前不驗證，任何人都能拿到
 * Telegram chat id、bot 名稱、哪些 API key 已設定（2026-11 稽核 S2 / S10）。
 */
function diagAuthorized_(e) {
  var given = (e && e.parameter && e.parameter.secret) || null;
  var expected = PROP.getProperty('TG_WEBHOOK_SECRET');
  return !!expected && secretEquals_(given, expected);
}

/**
 * 驗證 Firebase ID Token (由前端 firebase-auth SDK 產生)。
 * 回傳 { email } 若成功；失敗則回 { error: '<reason>' }，由 caller 放進 response body，
 * 讓前端能看到具體原因而不是 generic unauthorized。
 */
function authenticate_(e, opts) {
  opts = opts || {};
  // 只收 body 裡的 idToken（CLAUDE.md §9）：query string 會進 URL / access log
  var idToken = parseBody_(e).idToken || null;
  if (!idToken) return { error: 'no-id-token' };

  var apiKey = PROP.getProperty('FIREBASE_API_KEY');
  if (!apiKey) return { error: 'FIREBASE_API_KEY-not-set-in-script-properties' };

  try {
    var resp = UrlFetchApp.fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(apiKey),
      {
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        payload: JSON.stringify({ idToken: idToken }),
      },
    );
    var code = resp.getResponseCode();
    var body = resp.getContentText();
    if (code !== 200) {
      console.warn('authenticate_ lookup failed', code, body);
      var errMsg = 'lookup-' + code;
      try {
        var j = JSON.parse(body);
        if (j && j.error && j.error.message) errMsg = 'lookup: ' + j.error.message;
      } catch (_) {}
      return { error: errMsg };
    }
    var data = JSON.parse(body);
    var user = data && data.users && data.users[0];
    if (!user || !user.email) return { error: 'lookup-no-user' };
    if (user.emailVerified === false) return { error: 'email-not-verified' };

    // Whitelist check — 讀 config/allowedEmails OR config/guestEmails（viewer 名單）；email 比對不分大小寫
    var isViewer = false;
    var emailLower = String(user.email).toLowerCase();
    var whitelisted = false;
    try {
      var allowed = fsGetDoc_('config/allowedEmails');
      var allowedEmails = (allowed && Array.isArray(allowed.emails)) ? allowed.emails : [];
      var allowedLower = allowedEmails.map(function (x) { return String(x).toLowerCase(); });
      if (allowedLower.indexOf(emailLower) === -1) {
        // 檢查 viewer 名單（doc 名稱沿用 guestEmails，避免不必要遷移）
        var viewers = fsGetDoc_('config/guestEmails');
        var viewerEmails = (viewers && Array.isArray(viewers.emails)) ? viewers.emails : [];
        var viewerLower = viewerEmails.map(function (x) { return String(x).toLowerCase(); });
        if (viewerLower.indexOf(emailLower) === -1) {
          // joinHousehold 這類「還沒進白名單就要用」的 action 可以跳過白名單，但要 email 已驗證
          if (!opts.skipWhitelist) return { error: 'email-not-in-whitelist: ' + user.email };
        } else {
          isViewer = true;
        }
      } else {
        whitelisted = true;
      }
    } catch (fsErr) {
      console.error('whitelist read failed', fsErr);
      return { error: 'whitelist-read-failed: ' + String(fsErr && fsErr.message || fsErr) };
    }
    return { email: emailLower, uid: user.localId, isViewer: isViewer, whitelisted: whitelisted, displayName: user.displayName || '' };
  } catch (err) {
    console.error('authenticate_ failed', err);
    return { error: 'exception: ' + String(err && err.message || err) };
  }
}

function doGet(e) {
  return route_(e, 'GET');
}

function doPost(e) {
  return route_(e, 'POST');
}

function route_(e, method) {
  var action = (e && e.parameter && e.parameter.action) || '';
  var body = parseBody_(e);

  // Health check — no auth
  if (action === 'ping') {
    return jsonResponse_({ ok: true, ts: Date.now(), method: method });
  }

  // Telegram diag — 帶 secret 才能看（回 bot info + 最近 chat id 以排查 TG_CHAT_ID 設定）
  if (action === 'tgDiag') {
    if (!diagAuthorized_(e)) return jsonResponse_({ ok: false, error: 'tgDiag-unauthorized' }, 401);
    return jsonResponse_(telegramDiag());
  }

  // Telegram bot webhook — no Firebase auth；secret 在 tgWebhook_ 內驗證
  if (action === 'tgWebhook') {
    return tgWebhook_(e);
  }

  // 緊急 flush — 帶 secret 即可，繞過 Firebase auth；用來在 bot 卡 loop 時清 Telegram pending queue
  if (action === 'tgFlush') {
    if (!diagAuthorized_(e)) return jsonResponse_({ ok: false, error: 'tgFlush-unauthorized' }, 401);
    var flushResult = tgFlushPendingUpdates();
    // 順手清掉 dedup pointer 當 safety net：若 pointer 被寫到偏高的數字會把新訊息全部誤擋，重置是低成本的緊急手段
    try { tgResetDedup(); flushResult.dedupReset = true; } catch (resetErr) { console.warn('tgResetDedup', resetErr); }
    return jsonResponse_(flushResult);
  }

  // 看 webhook 狀態 — 同樣只驗 secret
  if (action === 'tgInfo') {
    if (!diagAuthorized_(e)) return jsonResponse_({ ok: false, error: 'tgInfo-unauthorized' }, 401);
    return jsonResponse_(tgWebhookInfo());
  }

  // Diagnostics — 帶 secret 才能看（哪些 key 已設、模型名、白名單人數都是攻擊者想知道的資訊）
  if (action === 'diag') {
    if (!diagAuthorized_(e)) return jsonResponse_({ ok: false, error: 'diag-unauthorized' }, 401);
    var out = {
      ok: true,
      ts: Date.now(),
      hasFirebaseProjectId: !!PROP.getProperty('FIREBASE_PROJECT_ID'),
      hasFirebaseApiKey: !!PROP.getProperty('FIREBASE_API_KEY'),
      hasTgBotToken: !!PROP.getProperty('TG_BOT_TOKEN'),
      hasTgChatId: !!PROP.getProperty('TG_CHAT_ID'),
      hasFinnhubKey: !!PROP.getProperty('FINNHUB_API_KEY'),
      hasAnthropicKey: claudeConfigured_(),
      hasDuffelToken: !!PROP.getProperty('DUFFEL_ACCESS_TOKEN'),
      hasFlightIngestToken: !!PROP.getProperty('FLIGHT_INGEST_TOKEN_SHA256'),
      hasMcpToken: !!PROP.getProperty('MCP_TOKEN_SHA256'),
      flightProvider: flightProvider_(),
      flightAiFallbackEnabled: flightAiFallbackEnabled_(),
      hasEinvoiceAppId: !!PROP.getProperty('EINVOICE_APP_ID'),
      hasEinvoiceCardNo: !!PROP.getProperty('EINVOICE_CARD_NO'),
      hasEinvoiceCardEncrypt: !!PROP.getProperty('EINVOICE_CARD_ENCRYPT'),
      claudeModels: {
        default: claudeModelFor_('default'),
        fast: claudeModelFor_('fast'),
      },
    };
    try {
      var allowed = fsGetDoc_('config/allowedEmails');
      out.whitelistDocExists = !!allowed;
      out.whitelistEmailCount = (allowed && allowed.emails) ? allowed.emails.length : 0;
    } catch (err) {
      out.whitelistReadError = String(err && err.message || err);
    }
    return jsonResponse_(out);
  }

  // Claude 排程推送機票價格 — 不走 Firebase auth，改驗專用 ingest token（只寫不讀，見 FlightIngest.gs）
  if (action === 'ingestFlightPrices') {
    if (method !== 'POST') return jsonResponse_({ ok: false, error: 'POST only' }, 405);
    try {
      return jsonResponse_(ingestFlightPricesWithToken_(body));
    } catch (ingestErr) {
      console.error('ingestFlightPrices failed', ingestErr);
      return jsonResponse_({ ok: false, error: 'flight ingest failed' }, 500);
    }
  }

  // Claude 排程推送股市輿情 — 同樣不走 Firebase auth，驗專用 ingest token（只寫不讀，見 StockRadarIngest.gs）
  if (action === 'ingestStockSentiment') {
    if (method !== 'POST') return jsonResponse_({ ok: false, error: 'POST only' }, 405);
    try {
      return jsonResponse_(ingestStockSentimentWithToken_(body));
    } catch (stockIngestErr) {
      console.error('ingestStockSentiment failed', stockIngestErr);
      return jsonResponse_({ ok: false, error: 'stock ingest failed' }, 500);
    }
  }

  // Claude 排程推送台指期輿情 — 驗專用 ingest token（只寫不讀，見 TaifexIngest.gs）
  if (action === 'ingestTaifexSentiment') {
    if (method !== 'POST') return jsonResponse_({ ok: false, error: 'POST only' }, 405);
    try {
      return jsonResponse_(ingestTaifexSentimentWithToken_(body));
    } catch (taifexIngestErr) {
      console.error('ingestTaifexSentiment failed', taifexIngestErr);
      return jsonResponse_({ ok: false, error: 'taifex ingest failed' }, 500);
    }
  }

  // MCP 端點 — 外部 AI client（Claude.ai / Claude Code）查資料，owner 開啟寫入的連線另可記帳 / 匯入行程；
  // 不走 Firebase auth，驗專用 MCP token 或閘道密鑰（見 Mcp.gs）
  if (action === 'mcp') {
    return mcpEndpoint_(e, method);
  }

  // 白名單檢查（前端 fallback）：前端先比對 config/*Hashes；比不到（雜湊 doc 還沒建、或剛被加進名單）
  // 就來問這裡。以 script owner 身分讀明文名單，所以任何已登入 Google 帳號都能查「自己」能不能用；
  // 順便把雜湊 doc 補齊（10 分鐘最多一次），之後前端就不用再問。
  if (action === 'checkAccess') {
    var accessAuth = authenticate_(e, { skipWhitelist: true });
    if (!accessAuth || !accessAuth.email) {
      return jsonResponse_({ ok: false, error: 'unauthorized: ' + ((accessAuth && accessAuth.error) || 'unknown') }, 401);
    }
    try { syncWhitelistHashesThrottled_(); } catch (syncErr) { console.warn('checkAccess sync hashes', syncErr); }
    var access = accessAuth.whitelisted ? 'full' : (accessAuth.isViewer ? 'guest' : 'denied');
    return jsonResponse_({ ok: true, access: access });
  }

  // 邀請碼加入共同帳本：token 要有效，但可以還不在白名單（加入成功後就會被加進去）
  if (action === 'joinHousehold') {
    var joinAuth = authenticate_(e, { skipWhitelist: true });
    if (!joinAuth || !joinAuth.email) {
      return jsonResponse_({ ok: false, error: 'unauthorized: ' + ((joinAuth && joinAuth.error) || 'unknown') }, 401);
    }
    try {
      return jsonResponse_(joinHousehold(parseBody_(e), joinAuth));
    } catch (joinErr) {
      console.error('joinHousehold failed', joinErr);
      return jsonResponse_({ ok: false, error: String(joinErr && joinErr.message || joinErr) }, 500);
    }
  }

  // All other actions require auth
  var authResult = authenticate_(e);
  if (!authResult || !authResult.email) {
    var reason = (authResult && authResult.error) || 'unknown';
    return jsonResponse_({ ok: false, error: 'unauthorized: ' + reason }, 401);
  }
  // Viewer 只能呼叫接受邀請，避免他們動到全 app 資料
  if (authResult.isViewer && action !== 'acceptPendingInvites' && action !== 'ping') {
    return jsonResponse_({ ok: false, error: 'viewer-not-allowed: ' + action }, 403);
  }
  // 非共同帳本 action（exportData / askFinance / 股價 / 快照…）都會讀寫 owner 全部資料：
  // 只有 users/{uid}.role 是 owner / admin 的人能呼叫（allowlist）。
  // 以前只擋 role === 'member'，白名單內但還沒有 users doc、或 role 是 viewer 的人會被當 owner 放行（2026-11 稽核 S9）。
  if (MEMBER_ALLOWED_ACTIONS_.indexOf(action) < 0) {
    var caller = null;
    try { caller = authResult.uid ? fsGetDoc_('users/' + authResult.uid) : null; } catch (roleErr) {
      console.error('role lookup failed', roleErr);
      return jsonResponse_({ ok: false, error: 'role-lookup-failed' }, 500);
    }
    var callerRole = caller && caller.role;
    if (callerRole !== 'owner' && callerRole !== 'admin') {
      return jsonResponse_({ ok: false, error: 'role-not-allowed: ' + action + ' (' + (callerRole || 'no-user-doc') + ')' }, 403);
    }
  }

  try {
    switch (action) {
      case 'updateStockPrices':
        return jsonResponse_(updateStockPrices());
      case 'refreshSymbol':
        return jsonResponse_(refreshSymbol((e.parameter && e.parameter.symbol) || body.symbol));
      case 'updateStockHistory':
        return jsonResponse_(appendStockHistorySnapshot());
      case 'updateFxRates':
        return jsonResponse_(updateFxRates());
      case 'checkAlerts':
        return jsonResponse_(checkAllAlerts());
      case 'generateItinerary':
        return jsonResponse_(generateItinerary(body));
      case 'parseItineraryText':
        return jsonResponse_(parseItineraryText(body));
      case 'suggestDayItems':
        return jsonResponse_(suggestDayItems(body));
      case 'generateTripNotes':
        return jsonResponse_(generateTripNotes(body));
      case 'refreshFlightWatch':
        return jsonResponse_(refreshFlightWatch(body, authResult));
      case 'importFlightPrices':
        return jsonResponse_(importFlightPrices(body, authResult));
      case 'getFlightIngestStatus':
        return jsonResponse_(getFlightIngestStatus(body, authResult));
      case 'setFlightIngestToken':
        return jsonResponse_(setFlightIngestToken(body, authResult));
      case 'revokeFlightIngestToken':
        return jsonResponse_(revokeFlightIngestToken(body, authResult));
      case 'geocode':
        return jsonResponse_(geocodePlace(Object.assign({}, e.parameter, body)));
      case 'placesSearch':
        return jsonResponse_(placesSearch(Object.assign({}, e.parameter, body)));
      case 'placeDetails':
        return jsonResponse_(placeDetails(Object.assign({}, e.parameter, body)));
      case 'resolveGoogleMapsUrl':
        return jsonResponse_(resolveGoogleMapsUrl(Object.assign({}, e.parameter, body)));
      case 'exportData':
        return jsonResponse_(exportAllData());
      case 'dryRunAccountsMigration':
        return jsonResponse_(dryRunAccountsMigration());
      case 'runRecurring':
        return jsonResponse_(runRecurringTransactions());
      case 'runInstallments':
        // 新建分期計畫後前端立即呼叫，讓已到期的期數馬上入帳（不用等隔天 01:00）
        return jsonResponse_(runInstallmentPlans());
      case 'parseReceipt':
        return jsonResponse_(parseReceipt(body));
      case 'parseImport':
        return jsonResponse_(parseImport(body));
      case 'askFinance':
        return jsonResponse_(askFinance(body));
      case 'getAiUsageSummary':
        return jsonResponse_(getAiUsageSummary(body, authResult));
      case 'estimateClaudeAnalysis':
        return jsonResponse_(estimateClaudeAnalysis(body));
      case 'runClaudeAnalysis':
        return jsonResponse_(runClaudeAnalysis(body));
      case 'getMcpStatus':
        return jsonResponse_(getMcpStatus());
      case 'setMcpToken':
        return jsonResponse_(setMcpToken(body, authResult));
      case 'revokeMcpToken':
        return jsonResponse_(revokeMcpToken(body, authResult));
      case 'setMcpWriteAccess':
        return jsonResponse_(setMcpWriteAccess(body, authResult));
      case 'syncEInvoices':
        return jsonResponse_(syncEInvoices(Object.assign({}, e.parameter, body)));
      case 'updateDividendCalendar':
        return jsonResponse_(updateDividendCalendar());
      case 'setupTriggers':
        // 重新註冊全部 time-driven triggers（新增 trigger 後從 web 端呼叫一次即可）
        return jsonResponse_(setupTriggers());
      case 'backfillCandles':
        return jsonResponse_(backfillCandles(Object.assign({}, e.parameter, body)));
      case 'updateDailyCandles':
        return jsonResponse_(updateDailyCandles());
      case 'snapshotPortfolio':
        return jsonResponse_(snapshotPortfolioDaily());
      case 'refreshPortfolioSnapshot':
        return jsonResponse_(refreshPortfolioSnapshot());
      case 'snapshotNetWorth':
        return jsonResponse_(snapshotNetWorthMonthly());
      case 'runSwingScan':
        return jsonResponse_(runSwingScan());
      case 'syncSwingPaperTrades':
        return jsonResponse_(syncSwingPaperTrades());
      case 'runStockRadar':
        return jsonResponse_(runStockRadar((e.parameter && e.parameter.market) || body.market));
      case 'runStockRadarBacktest':
        return jsonResponse_(runStockRadarBacktest((e.parameter && e.parameter.market) || body.market));
      case 'syncStockRadarFlows':
        return jsonResponse_(syncStockRadarFlows());
      case 'importStockSentiment':
        return jsonResponse_(importStockSentiment(body, authResult));
      case 'getStockIngestStatus':
        return jsonResponse_(getStockIngestStatus(body, authResult));
      case 'setStockIngestToken':
        return jsonResponse_(setStockIngestToken(body, authResult));
      case 'revokeStockIngestToken':
        return jsonResponse_(revokeStockIngestToken(body, authResult));
      case 'runTaifexDaily':
        return jsonResponse_(runTaifexDaily({}));
      case 'backfillTaifex':
        return jsonResponse_(backfillTaifex(body));
      case 'runTaifexBacktest':
        return jsonResponse_(runTaifexBacktest());
      case 'placeTaifexOrder':
        return jsonResponse_(placeTaifexOrder(body));
      case 'cancelTaifexOrder':
        return jsonResponse_(cancelTaifexOrder());
      case 'resetTaifexPaper':
        return jsonResponse_(resetTaifexPaper());
      case 'resumeTaifexPaper':
        return jsonResponse_(resumeTaifexPaper());
      case 'importTaifexSentiment':
        return jsonResponse_(importTaifexSentiment(body, authResult));
      case 'getTaifexIngestStatus':
        return jsonResponse_(getTaifexIngestStatus(body, authResult));
      case 'setTaifexIngestToken':
        return jsonResponse_(setTaifexIngestToken(body, authResult));
      case 'revokeTaifexIngestToken':
        return jsonResponse_(revokeTaifexIngestToken(body, authResult));
      case 'diagTaifex':
        return jsonResponse_(diagTaifex());
      case 'runTaifexIntraday':
        return jsonResponse_(runTaifexIntraday({ force: true }));
      case 'runTaifexOptimization':
        return jsonResponse_(runTaifexOptimization());
      case 'diagTaifexQuote':
        return jsonResponse_(diagTaifexQuote());
      case 'runTaifexTech':
        return jsonResponse_(runTaifexTechManual());
      case 'resetTaifexTech':
        return jsonResponse_(resetTaifexTech());
      case 'refreshTaifexCalendar':
        return jsonResponse_(refreshTaifexCalendar());
      case 'applyTaifexReview':
        return jsonResponse_(applyTaifexReview(body, authResult));
      case 'rejectTaifexReview':
        return jsonResponse_(rejectTaifexReview(body, authResult));
      case 'revertTaifexTuning':
        return jsonResponse_(revertTaifexTuning(body, authResult));
      case 'syncTripDocument':
        return jsonResponse_(syncTripDocumentToDrive(body));
      case 'inviteTripUser':
        return jsonResponse_(inviteTripUser(body, authResult));
      case 'inviteHouseholdMember':
        return jsonResponse_(inviteHouseholdMember(body, authResult));
      case 'createTelegramLink':
        return jsonResponse_(createTelegramLink(body, authResult));
      case 'unlinkTelegram':
        return jsonResponse_(unlinkTelegram(body, authResult));
      case 'sendHouseholdReport':
        return jsonResponse_(sendHouseholdReportNow(body, authResult));
      case 'refreshHouseholdQuotes':
        return jsonResponse_(refreshHouseholdQuotes(body, authResult));
      case 'acceptPendingInvites':
        return jsonResponse_(acceptPendingInvites(body, authResult));
      case 'notify': {
        // ?kind=ledgerDaily | ledgerMonthly | budgetWarn | tripDaily | tripCountdown | marketDaily | recurringRun
        var kind = (e.parameter && e.parameter.kind) || body.kind || '';
        switch (kind) {
          case 'ledgerDaily': return jsonResponse_(notifyLedgerDaily());
          case 'ledgerMonthly': return jsonResponse_(notifyLedgerMonthly());
          case 'budgetWarn': return jsonResponse_(notifyBudgetWarn());
          case 'tripDaily': return jsonResponse_(notifyTripDaily());
          case 'tripCountdown': return jsonResponse_(notifyTripCountdown());
          case 'marketDaily': return jsonResponse_(notifyMarketDaily());
          case 'recurringRun': return jsonResponse_(notifyRecurringRun(1, [{ title: 'Demo' }]));
          case 'errorDigest': return jsonResponse_(notifyErrorDigest());
          case 'loansReminder': return jsonResponse_(notifyLoansReminder());
          case 'payoutGroupReminder': return jsonResponse_(notifyPayoutGroupsReminder());
          case 'weeklyReview': return jsonResponse_(notifyWeeklyReview());
          case 'dividendCalendar': return jsonResponse_(notifyDividendCalendar());
          case 'taxSeason': return jsonResponse_(notifyTaxSeason());
          case 'einvoiceSync': return jsonResponse_(notifyEInvoiceSync_({ created: 1, totalTWD: 150, skipped: 0, uncategorized: 1 }, [{ seller: '測試商店', amount: 150, category: 'other' }]));
          case 'creditCardDue': return jsonResponse_(notifyCreditCardDues());
          case 'loanDue': return jsonResponse_(notifyAccountLoansDue());
          case 'insuranceDue': return jsonResponse_(notifyInsuranceDue());
          case 'subscriptionsDigest': return jsonResponse_(notifySubscriptionsDigest());
          case 'monthlyForecast': return jsonResponse_(notifyMonthlyForecast());
          case 'categoryAnomaly': return jsonResponse_(notifyCategoryAnomaly());
          case 'scheduledPaymentDue': return jsonResponse_(notifyScheduledPaymentDue());
          case 'savingsGoalProgress': return jsonResponse_(notifySavingsGoalProgress());
          case 'investmentPlanProgress': return jsonResponse_(notifyInvestmentPlanProgress());
          case 'financialHealthDigest': return jsonResponse_(notifyFinancialHealthDigest());
          case 'tripRecap': return jsonResponse_(notifyTripRecap());
          case 'fixedExpensesMonthly': return jsonResponse_(notifyFixedExpensesMonthly());
          case 'weeklyBackup': return jsonResponse_(weeklyBackupRun());
          case 'fxDaily': return jsonResponse_(notifyFxDaily());
          case 'stockRadar': return jsonResponse_(notifyStockRadarLatest_());
          case 'taifex': return jsonResponse_(notifyTaifexLatest_());
          case 'householdReport': return jsonResponse_(runHouseholdReports(true));
          default: return jsonResponse_({ ok: false, error: 'unknown notify kind: ' + kind });
        }
      }
      case 'dailySummary':
        return jsonResponse_(sendDailySummary());
      case 'sendTest':
        return jsonResponse_(sendTelegramTest());
      default:
        return jsonResponse_({ ok: false, error: 'unknown action: ' + action }, 400);
    }
  } catch (err) {
    console.error('route_ error', action, err);
    return jsonResponse_({ ok: false, error: String(err && err.message || err) }, 500);
  }
}
