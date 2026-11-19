/**
 * Claude 排程 → 機票雷達的結果推送通道。
 *
 * Claude 排程（claude.ai scheduled task）自己上網查價，整理成 JSON 後 POST 到
 * `?action=ingestFlightPrices`。這個入口不吃 Firebase idToken（排程無法登入 Google），
 * 改用專用的 ingest token，並把權限壓到最小：
 *
 * - Token 由前端用 crypto.getRandomValues 產生，Apps Script 只保存 SHA-256 雜湊；明文只出現在
 *   使用者的 Claude 環境變數裡。可隨時在前端輪替或撤銷。
 * - 只寫不讀：回應只有每筆 watchId 的成功／失敗與錯誤原因，不回傳任何 Firestore 資料，
 *   就算 token 外洩也拿不到帳本或行程。
 * - 只能寫 token 擁有者、scanProvider = 'claude'、啟用中的 watch；每筆結果必須帶
 *   criteriaKey，與目前搜尋條件不符（提示詞過期）就拒收。
 * - 價格、日期、晚數、艙等、直飛、航空公司條件都經 buildFlightEstimateFromRaw_ 再驗一次；
 *   來源必須是 https URL；異常低價降為低可信度、不更新歷史最低、不發低價通知。
 * - 每日總量與每條航線每日次數都有上限，擋掉重送或被濫用時的灌資料。
 *
 * 另有 `importFlightPrices`（Firebase idToken 驗證）給「手動貼上 Claude 輸出」使用，規則相同。
 */

var FLIGHT_INGEST_MAX_RESULTS_ = 20;
var FLIGHT_INGEST_MAX_PAYLOAD_CHARS_ = 200000;
var FLIGHT_INGEST_DAILY_LIMIT_ = 60;
var FLIGHT_INGEST_PER_WATCH_DAILY_LIMIT_ = 6;
var FLIGHT_INGEST_SUSPICIOUS_RATIO_ = 0.4;
var FLIGHT_INGEST_TOKEN_PATTERN_ = /^rmfi_[A-Za-z0-9_-]{43}$/;
var FLIGHT_WATCH_ID_PATTERN_ = /^[A-Za-z0-9_-]{1,64}$/;

function flightIngestSha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8)
    .map(function (byte) {
      var value = (byte + 256) % 256;
      return (value < 16 ? '0' : '') + value.toString(16);
    })
    .join('');
}

function flightIngestSafeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length || a.length === 0) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 搜尋條件指紋：前端產生提示詞時算一次，推送時再比對，條件改了舊提示詞就會被拒收。
 * 前端同邏輯在 apps/web/src/features/flight-watches/claude-schedule.ts（flightCriteriaKey），改這裡要一起改。
 */
function flightWatchCriteriaKey_(watch) {
  var filter = watch.airlineFilter === 'include' || watch.airlineFilter === 'exclude' ? watch.airlineFilter : 'all';
  var codes = filter === 'all' || !Array.isArray(watch.airlineCodes)
    ? []
    : watch.airlineCodes.map(function (code) { return String(code).trim().toUpperCase(); }).sort();
  var canonical = [
    String(watch.origin || '').trim().toUpperCase(),
    String(watch.destination || '').trim().toUpperCase(),
    formatFlightWatchDate_(watch.departureStart),
    formatFlightWatchDate_(watch.departureEnd),
    Number(watch.minNights) || 3,
    Number(watch.maxNights) || 7,
    Number(watch.adults) || 1,
    flightWatchCabins_(watch).slice().sort().join(','),
    watch.nonstopOnly === true ? 1 : 0,
    watch.excludeLowCostCarriers === true ? 1 : 0,
    filter,
    codes.join(','),
  // 單程／多點進出才多加段落，來回的指紋與舊版相同，既有提示詞不會因升級而失效
  ].concat(flightTripType_(watch) === 'oneway' ? ['oneway'] : [])
    .concat(flightTripType_(watch) === 'openjaw'
      ? ['openjaw', String(watch.returnOrigin || '').trim().toUpperCase(), String(watch.returnDestination || '').trim().toUpperCase()]
      : [])
    // 購票方式只有不是該行程預設值時才加，既有提示詞不會因升級而失效
    .concat(flightTicketSearch_(watch) !== flightTicketSearchDefault_(watch) ? ['ticket:' + flightTicketSearch_(watch)] : [])
    .join('|');
  return flightIngestSha256Hex_(canonical).slice(0, 12);
}

// -------- token 管理（Firebase idToken 驗證後由前端呼叫） --------

function setFlightIngestToken(body, authResult) {
  var hash = String((body && body.tokenHash) || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, error: 'invalid tokenHash' };
  if (!authResult || !authResult.uid) return { ok: false, error: 'missing uid' };
  var createdAt = new Date().toISOString();
  PROP.setProperties({
    FLIGHT_INGEST_TOKEN_SHA256: hash,
    FLIGHT_INGEST_UID: authResult.uid,
    FLIGHT_INGEST_CREATED_AT: createdAt,
  });
  PROP.deleteProperty('FLIGHT_INGEST_LAST_USED_AT');
  return { ok: true, createdAt: createdAt };
}

function revokeFlightIngestToken(body, authResult) {
  if (!authResult || !authResult.uid) return { ok: false, error: 'missing uid' };
  ['FLIGHT_INGEST_TOKEN_SHA256', 'FLIGHT_INGEST_UID', 'FLIGHT_INGEST_CREATED_AT', 'FLIGHT_INGEST_LAST_USED_AT']
    .forEach(function (key) { PROP.deleteProperty(key); });
  return { ok: true };
}

function getFlightIngestStatus(body, authResult) {
  var configured = !!PROP.getProperty('FLIGHT_INGEST_TOKEN_SHA256');
  return {
    ok: true,
    configured: configured,
    ownedByCaller: configured && !!authResult && PROP.getProperty('FLIGHT_INGEST_UID') === authResult.uid,
    createdAt: PROP.getProperty('FLIGHT_INGEST_CREATED_AT') || null,
    lastUsedAt: PROP.getProperty('FLIGHT_INGEST_LAST_USED_AT') || null,
  };
}

// -------- 推送入口 --------

/** Claude 排程呼叫：ingest token 驗證，沒有 Firebase idToken。 */
function ingestFlightPricesWithToken_(body) {
  var expected = PROP.getProperty('FLIGHT_INGEST_TOKEN_SHA256');
  var uid = PROP.getProperty('FLIGHT_INGEST_UID');
  var token = String((body && body.ingestToken) || '');
  // 一律回同一個錯誤，不透露是沒設定、格式錯還是 token 不對。
  if (!expected || !uid || !FLIGHT_INGEST_TOKEN_PATTERN_.test(token)
      || !flightIngestSafeEqual_(flightIngestSha256Hex_(token), expected)) {
    return { ok: false, error: 'flight-ingest-unauthorized' };
  }
  PROP.setProperty('FLIGHT_INGEST_LAST_USED_AT', new Date().toISOString());
  return applyFlightIngest_(body, uid, { requireClaudeProvider: true });
}

/** 前端「貼上 Claude 結果」：Firebase idToken 驗證，可寫自己任何一條航線。 */
function importFlightPrices(body, authResult) {
  if (!authResult || !authResult.uid) return { ok: false, error: 'missing uid' };
  return applyFlightIngest_(body, authResult.uid, { requireClaudeProvider: false });
}

function applyFlightIngest_(body, uid, opts) {
  var results = body && body.results;
  if (!Array.isArray(results) || results.length === 0) return { ok: false, error: 'results 必須是非空陣列' };
  if (results.length > FLIGHT_INGEST_MAX_RESULTS_) {
    return { ok: false, error: '一次最多 ' + FLIGHT_INGEST_MAX_RESULTS_ + ' 筆航線結果' };
  }
  if (JSON.stringify(results).length > FLIGHT_INGEST_MAX_PAYLOAD_CHARS_) {
    return { ok: false, error: 'payload 過大' };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'flight ingest locked' };
  try {
    var day = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');
    var cache = CacheService.getScriptCache();
    var dailyKey = 'flight-ingest-' + day;
    var dailyUsed = Number(cache.get(dailyKey)) || 0;
    var seen = {};
    var notifications = [];
    var outcomes = results.map(function (item) {
      var rawId = String((item && item.watchId) || '');
      var outcome = { watchId: FLIGHT_WATCH_ID_PATTERN_.test(rawId) ? rawId : '', ok: false };
      var recordable = null;
      try {
        if (!outcome.watchId) throw new Error('watchId 格式錯誤');
        if (seen[rawId]) throw new Error('同一批結果的 watchId 重複');
        seen[rawId] = true;
        if (dailyUsed >= FLIGHT_INGEST_DAILY_LIMIT_) throw new Error('今日匯入總次數已達上限');

        var watch = fsGetDoc_('flight_watches/' + rawId);
        // 不存在與不屬於 token 擁有者回同一個訊息，避免被拿來探測 watchId。
        if (!watch || watch.userId !== uid) throw new Error('找不到此航線');
        if (opts.requireClaudeProvider && flightProvider_(watch) !== 'claude') {
          throw new Error('此航線的資料來源不是 Claude 排程');
        }
        if (opts.requireClaudeProvider && watch.enabled === false) throw new Error('此航線已暫停');
        recordable = watch;

        var watchKey = dailyKey + '-' + rawId;
        var watchUsed = Number(cache.get(watchKey)) || 0;
        if (watchUsed >= FLIGHT_INGEST_PER_WATCH_DAILY_LIMIT_) throw new Error('此航線今日匯入次數已達上限');
        dailyUsed++;
        cache.put(dailyKey, String(dailyUsed), 93600);
        cache.put(watchKey, String(watchUsed + 1), 93600);

        if (String(item.criteriaKey || '') !== flightWatchCriteriaKey_(watch)) {
          throw new Error('搜尋條件已變更，請到機票雷達重新複製 Claude 排程提示詞');
        }
        var parsed = parseClaudeFlightResult_(item, watch);
        saveFlightWatchEstimate_(watch, parsed.estimate, { skipBestPrice: parsed.suspicious });
        outcome.ok = true;
        outcome.minPriceTWD = parsed.estimate.minPriceTWD;
        if (parsed.suspicious) outcome.warning = 'suspicious-low-price';

        var isDeal = !parsed.suspicious && isFlightDeal_(watch, parsed.estimate);
        if (watch.notifyOnEveryScan === true || (watch.notifyOnDeal !== false && isDeal)) {
          notifications.push({ watch: watch, estimate: parsed.estimate, isDeal: isDeal });
        }
      } catch (err) {
        outcome.error = String((err && err.message) || err).slice(0, 200);
        if (recordable) saveFlightWatchError_(recordable, new Error('Claude 排程：' + outcome.error));
      }
      return outcome;
    });

    if (notifications.length > 0) {
      try {
        notifyFlightPrices_(notifications);
      } catch (notifyErr) {
        console.error('flight ingest notify', notifyErr);
      }
    }
    var accepted = outcomes.filter(function (outcome) { return outcome.ok; }).length;
    // ok 代表請求有被處理；個別航線是否被接受看 accepted / results[].error。
    return { ok: true, accepted: accepted, rejected: outcomes.length - accepted, results: outcomes };
  } finally {
    lock.releaseLock();
  }
}

function parseClaudeFlightResult_(item, watch) {
  if (item.available !== true && String(item.available).toLowerCase() !== 'true') {
    var reason = String(item.reason || item.priceReason || '').slice(0, 160);
    throw new Error('公開搜尋暫無可用票價' + (reason ? '：' + reason : ''));
  }
  var seen = {};
  var sources = (Array.isArray(item.sources) ? item.sources : [])
    .map(cleanFlightIngestSource_)
    .filter(function (source) {
      if (!source || seen[source.url]) return false;
      seen[source.url] = true;
      return true;
    })
    .slice(0, 5);
  if (sources.length === 0) throw new Error('結果沒有附上可驗證的 https 來源網址');

  var estimate = buildFlightEstimateFromRaw_(item, sources, watch, 'Claude');
  estimate.provider = 'claude';
  var previousTypical = watch.latestEstimate && Number(watch.latestEstimate.typicalPriceTWD);
  var suspicious = !!previousTypical && estimate.minPriceTWD < previousTypical * FLIGHT_INGEST_SUSPICIOUS_RATIO_;
  if (suspicious) {
    estimate.confidence = 'low';
    estimate.advice = 'watch';
    estimate.adviceReason = '較低價比前次常見價低 60% 以上，可能是錯誤或不符條件的票價，請自行到來源確認。';
  }
  return { estimate: estimate, suspicious: suspicious };
}

function cleanFlightIngestSource_(source) {
  if (!source || typeof source !== 'object') return null;
  var url = String(source.url || '').trim();
  if (url.length > 500 || !/^https:\/\/[^\s"'<>\\]+$/i.test(url)) return null;
  var title = String(source.title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160);
  return { title: title || url, url: url };
}
