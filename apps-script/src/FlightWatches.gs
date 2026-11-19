/**
 * 機票價格訂閱：每筆 watch 可選 Duffel Flights API 或 Claude API + Web Search（scanProvider = 'claude_api'）。
 *
 * Duffel 路徑每次只輪替一組日期，並有月 request 硬上限；Claude API 結果必須附上 web search 來源，
 * 模型沿用 設定 → AI 額度 的預設模型。舊資料沒有 scanProvider 時才沿用 Script Properties 的全域設定。
 * 舊的 scanProvider = 'gemini' 視同 'claude_api'（2026-11 Gemini → Claude 遷移）。
 * scanProvider = 'claude' 的 watch 不由這裡掃描，改由 Claude 排程推送結果（見 FlightIngest.gs）。
 */

var FLIGHT_WATCH_BATCH_SIZE = 10;
var FLIGHT_API_DEFAULT_MONTHLY_LIMIT_ = 300;
// 每次保存的候選日期組數；前端用來比較哪段時間出發最便宜
var FLIGHT_MAX_TRAVEL_WINDOWS_ = 12;
// 每次掃描最多幾次 web search（$10 / 1,000 次）
var FLIGHT_CLAUDE_MAX_SEARCHES_ = 5;

/** Script Property 名稱沿用舊的 FLIGHT_ALLOW_GEMINI_FALLBACK（只影響沒有 scanProvider 的舊 watch） */
function flightAiFallbackEnabled_() {
  return String(PROP.getProperty('FLIGHT_ALLOW_GEMINI_FALLBACK') || '').toLowerCase() === 'true';
}

function flightProvider_(watch) {
  var selected = String((watch && watch.scanProvider) || '').toLowerCase();
  if (selected === 'duffel') return PROP.getProperty('DUFFEL_ACCESS_TOKEN') ? 'duffel' : 'disabled';
  // 選 Claude API 是 watch 層級的明確 opt-in；舊的 'gemini' 一併轉過來。
  if (selected === 'claude_api' || selected === 'gemini') return claudeConfigured_() ? 'claude_api' : 'disabled';
  // Claude 排程自己查價後推送結果；Apps Script 不打任何外部 API。
  if (selected === 'claude') return 'claude';

  // Backward compatibility for watches created before per-watch provider selection existed.
  var configured = String(PROP.getProperty('FLIGHT_API_PROVIDER') || '').toLowerCase();
  var hasDuffel = !!PROP.getProperty('DUFFEL_ACCESS_TOKEN');
  if ((!configured || configured === 'duffel') && hasDuffel) return 'duffel';
  var aiConfigured = configured === 'gemini' || configured === 'claude_api' || !configured;
  if (aiConfigured && flightAiFallbackEnabled_() && claudeConfigured_()) return 'claude_api';
  return 'disabled';
}

function refreshFlightWatch(body, authResult) {
  var watchId = body && body.watchId;
  if (!watchId) return { ok: false, error: 'missing watchId' };
  var watch = fsGetDoc_('flight_watches/' + watchId);
  if (!watch) return { ok: false, error: 'flight watch not found' };
  if (!authResult || watch.userId !== authResult.uid) {
    return { ok: false, error: 'flight watch forbidden' };
  }
  if (flightProvider_(watch) === 'claude') {
    return { ok: false, error: '此航線由 Claude 排程更新，請等待排程或在「Claude 排程」貼上結果' };
  }
  var result = scanFlightWatchDocs_([watch], false);
  if (!result.ok) return result;
  return { ok: true, updated: result.updated, failed: result.failed };
}

function scanFlightWatches() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, skipped: true, error: 'flight watch scan locked' };
  try {
    var now = new Date();
    var watches = fsListAllDocs_('flight_watches', 100).filter(function (watch) {
      return watch.enabled !== false
        && watch.departureEnd instanceof Date
        && watch.departureEnd >= now
        && flightProvider_(watch) !== 'claude'
        && isFlightWatchDue_(watch, now);
    });
    watches.sort(function (a, b) {
      var aTime = a.lastCheckedAt instanceof Date ? a.lastCheckedAt.getTime() : 0;
      var bTime = b.lastCheckedAt instanceof Date ? b.lastCheckedAt.getTime() : 0;
      return aTime - bTime;
    });
    return scanFlightWatchDocs_(watches.slice(0, FLIGHT_WATCH_BATCH_SIZE), true);
  } finally {
    lock.releaseLock();
  }
}

function scanFlightWatchDocs_(watches, notifyDeals) {
  if (!watches || watches.length === 0) {
    return { ok: true, updated: 0, failed: 0, skipped: true, provider: 'none' };
  }
  var groups = {};
  var failed = 0;
  var errors = [];
  watches.forEach(function (watch) {
    var provider = flightProvider_(watch);
    if (provider === 'claude') return;
    if (provider === 'disabled') {
      var requested = String(watch.scanProvider || 'configured provider');
      var message = requested === 'gemini' || requested === 'claude_api'
        ? 'Claude API scan selected but ANTHROPIC_API_KEY is not set'
        : requested === 'duffel'
          ? 'Duffel scan selected but DUFFEL_ACCESS_TOKEN is not set'
          : 'flight provider not configured';
      saveFlightWatchError_(watch, new Error(message));
      errors.push(message);
      failed++;
      return;
    }
    var groupKey = provider;
    if (!groups[groupKey]) groups[groupKey] = { provider: provider, watches: [] };
    groups[groupKey].watches.push(watch);
  });

  var updated = 0;
  var providerNames = {};
  Object.keys(groups).forEach(function (groupKey) {
    var group = groups[groupKey];
    providerNames[group.provider] = true;
    try {
      var result = group.provider === 'duffel'
        ? scanFlightWatchDocsWithDuffel_(group.watches, notifyDeals)
        : scanFlightWatchDocsWithClaude_(group.watches, notifyDeals);
      updated += Number(result.updated) || 0;
      failed += Number(result.failed) || 0;
      if (result.error) errors.push(result.error);
    } catch (err) {
      group.watches.forEach(function (watch) { saveFlightWatchError_(watch, err); });
      failed += group.watches.length;
      errors.push(String(err && err.message || err));
    }
  });
  var providers = Object.keys(providerNames);
  return {
    ok: failed === 0,
    provider: providers.length === 1 ? providers[0] : 'mixed',
    updated: updated,
    failed: failed,
    error: errors.length > 0 ? errors.join('; ').slice(0, 500) : undefined,
  };
}

function scanFlightWatchDocsWithClaude_(watches, notifyDeals) {
  if (!watches || watches.length === 0) return { ok: true, updated: 0, failed: 0, skipped: true, provider: 'claude_api' };
  if (!claudeConfigured_()) return { ok: false, error: 'ANTHROPIC_API_KEY not set' };
  assertClaudeBudgetAvailable_();
  var model = claudeModelFor_('default');
  var payloads = watches.map(function (watch) {
    return claudeBuildPayload_({
      model: model,
      prompt: buildFlightWatchPrompt_(watch),
      maxTokens: 16000,
      effort: 'medium',
      webSearchMaxUses: FLIGHT_CLAUDE_MAX_SEARCHES_,
    });
  });

  var responses;
  try {
    responses = UrlFetchApp.fetchAll(payloads.map(claudeRequest_));
  } catch (err) {
    watches.forEach(function (watch) { saveFlightWatchError_(watch, err); });
    return { ok: false, error: String(err && err.message || err), updated: 0, failed: watches.length };
  }

  var updated = 0;
  var failed = 0;
  var notifications = [];
  responses.forEach(function (response, index) {
    var watch = watches[index];
    if (!watch) return;
    try {
      var data = claudeHandleResponse_(response, model, 'flightWatch');
      // web search 長回合可能 pause_turn：照原樣把 assistant content 接回去續跑（最多 2 次）
      var collected = (data.content || []).slice();
      var payload = payloads[index];
      for (var round = 0; data.stop_reason === 'pause_turn' && round < 2; round++) {
        payload.messages = payload.messages.concat([{ role: 'assistant', content: data.content }]);
        data = claudeHandleResponse_(UrlFetchApp.fetch(CLAUDE_API_BASE_ + '/messages', claudeFetchOptions_(payload)), model, 'flightWatch');
        collected = collected.concat(data.content || []);
      }
      var estimate = parseFlightWatchResponse_(JSON.stringify(Object.assign({}, data, { content: collected })), watch);
      estimate.provider = 'claude_api';
      saveFlightWatchEstimate_(watch, estimate);
      updated++;
      if (notifyDeals) {
        var isDeal = isFlightDeal_(watch, estimate);
        if (watch.notifyOnEveryScan === true || (watch.notifyOnDeal !== false && isDeal)) {
          notifications.push({ watch: watch, estimate: estimate, isDeal: isDeal });
        }
      }
    } catch (err) {
      failed++;
      saveFlightWatchError_(watch, err);
      console.error('flight watch scan', flightWatchId_(watch), err);
    }
  });

  if (notifications.length > 0) notifyFlightPrices_(notifications);
  return { ok: failed === 0, provider: 'claude_api', model: model, updated: updated, failed: failed };
}

function flightApiMonthlyLimit_() {
  var configured = Number(PROP.getProperty('FLIGHT_MONTHLY_REQUEST_LIMIT'));
  return isFinite(configured) && configured > 0 ? Math.floor(configured) : FLIGHT_API_DEFAULT_MONTHLY_LIMIT_;
}

function reserveFlightApiRequests_(count) {
  var month = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
  var key = 'FLIGHT_API_USAGE_' + month.replace('-', '_');
  var used = Math.max(0, Number(PROP.getProperty(key)) || 0);
  var limit = flightApiMonthlyLimit_();
  if (used + count > limit) {
    throw new Error('flight API monthly request limit reached (' + used + '/' + limit + ')');
  }
  PROP.setProperty(key, String(used + count));
  return { used: used + count, limit: limit };
}

function flightDateParts_(date) {
  var text = formatFlightWatchDate_(date);
  var match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function flightDateUtc_(date) {
  var parts = flightDateParts_(date);
  return parts ? new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)) : null;
}

function flightDateTextFromUtc_(date) {
  return Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd');
}

function flightDuffelWindow_(watch) {
  var start = flightDateUtc_(watch.departureStart);
  var end = flightDateUtc_(watch.departureEnd);
  if (!start || !end || end < start) throw new Error('invalid flight watch date range');
  var tomorrow = new Date();
  tomorrow = new Date(Date.UTC(
    Number(Utilities.formatDate(tomorrow, 'Asia/Taipei', 'yyyy')),
    Number(Utilities.formatDate(tomorrow, 'Asia/Taipei', 'M')) - 1,
    Number(Utilities.formatDate(tomorrow, 'Asia/Taipei', 'd')) + 1,
    12
  ));
  if (start < tomorrow) start = tomorrow;
  if (end < start) throw new Error('flight watch date range has passed');
  var dayCount = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  var watchSeed = flightWatchId_(watch).split('').reduce(function (sum, char) { return sum + char.charCodeAt(0); }, 0);
  var todaySeed = Math.floor(Date.now() / 86400000);
  var offset = (watchSeed + todaySeed) % dayCount;
  var nightRange = Math.max(1, Number(watch.maxNights) - Number(watch.minNights) + 1);
  var nights = Number(watch.minNights) + ((watchSeed + todaySeed) % nightRange);
  var departure = new Date(start.getTime() + offset * 86400000);
  if (flightTripType_(watch) === 'oneway') return { departure: flightDateTextFromUtc_(departure), returning: '' };
  var returning = new Date(departure.getTime() + nights * 86400000);
  return { departure: flightDateTextFromUtc_(departure), returning: flightDateTextFromUtc_(returning) };
}

/**
 * leg：'full' = 一張票（單程 / 來回 / 多城市），'outbound' = 只查去程單程，'return' = 只查回程單程（拼單程用）
 */
function flightDuffelRequest_(token, watch, cabin, window, leg) {
  leg = leg || 'full';
  var returnLeg = flightReturnLeg_(watch);
  var slices = [];
  if (leg !== 'return') {
    slices.push({ origin: String(watch.origin).toUpperCase(), destination: String(watch.destination).toUpperCase(), departure_date: window.departure });
  }
  if (leg !== 'outbound' && window.returning && returnLeg) {
    // 多點進出時回程從 returnOrigin 飛 returnDestination；Duffel 多個 slice 就是 multi-city 報價
    slices.push({ origin: returnLeg.from, destination: returnLeg.to, departure_date: window.returning });
  }
  return {
    url: 'https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=10000',
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      'Duffel-Version': 'v2',
    },
    payload: JSON.stringify({ data: {
      slices: slices,
      passengers: Array.apply(null, Array(Math.max(1, Number(watch.adults) || 1))).map(function () { return { type: 'adult' }; }),
      cabin_class: cabin,
      max_connections: watch.nonstopOnly ? 0 : 1,
    } }),
  };
}

function flightOfferAirline_(offer) {
  var carriers = {};
  ((offer && offer.slices) || []).forEach(function (slice) {
    ((slice && slice.segments) || []).forEach(function (segment) {
      var carrier = segment && (segment.operating_carrier || segment.marketing_carrier);
      if (!carrier) return;
      var label = [carrier.iata_code, carrier.name].filter(Boolean).join(' ');
      if (label) carriers[label] = true;
    });
  });
  var labels = Object.keys(carriers);
  if (labels.length > 0) return labels.join(' / ');
  var owner = offer && offer.owner;
  return owner ? [owner.iata_code, owner.name].filter(Boolean).join(' ') : '';
}

function flightOfferStops_(offer) {
  return ((offer && offer.slices) || []).reduce(function (maxStops, slice) {
    return Math.max(maxStops, Math.max(0, ((slice && slice.segments) || []).length - 1));
  }, 0);
}

function flightOfferTwd_(offer) {
  var amount = Number(offer && offer.total_amount);
  var currency = String((offer && offer.total_currency) || 'TWD').toUpperCase();
  if (!isFinite(amount) || amount <= 0) return null;
  if (currency === 'TWD') return amount;
  var cache = CacheService.getScriptCache();
  var cacheKey = 'flight-fx-' + currency + '-TWD';
  var cached = Number(cache.get(cacheKey));
  if (isFinite(cached) && cached > 0) return amount * cached;
  var rate = fsGetDoc_('fx_rates/' + currency + '_TWD');
  var twdRate = Number(rate && rate.rate);
  if (!isFinite(twdRate) || twdRate <= 0) throw new Error('missing FX rate ' + currency + '_TWD');
  cache.put(cacheKey, String(twdRate), 21600);
  return amount * twdRate;
}

/** Duffel 的 departing_at 是當地時間 ISO（不含時區），直接取 HH:mm；duration 是 ISO 8601（PT3H25M） */
function flightDuffelSliceDetails_(slice) {
  var segments = (slice && slice.segments) || [];
  var first = segments[0];
  var last = segments[segments.length - 1];
  var timeOf = function (value) {
    var match = String(value || '').match(/T(\d{2}:\d{2})/);
    return match ? match[1] : '';
  };
  var durationMatch = String((slice && slice.duration) || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
  var minutes = durationMatch
    ? (Number(durationMatch[1] || 0) * 1440) + (Number(durationMatch[2] || 0) * 60) + Number(durationMatch[3] || 0)
    : 0;
  var carrier = first && (first.marketing_carrier || first.operating_carrier);
  var flightNumber = carrier && first.marketing_carrier_flight_number
    ? String(carrier.iata_code || '') + String(first.marketing_carrier_flight_number)
    : '';
  return {
    departureTime: timeOf(first && first.departing_at),
    arrivalTime: timeOf(last && last.arriving_at),
    durationMinutes: minutes,
    flightNumber: flightNumber,
  };
}

function parseDuffelOffers_(response, context) {
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error('Duffel ' + response.getResponseCode() + ': ' + response.getContentText().slice(0, 500));
  }
  var payload = JSON.parse(response.getContentText());
  var offers = (payload && payload.data && payload.data.offers) || [];
  if (offers.some(function (offer) { return offer && offer.live_mode !== true; })) {
    throw new Error('Duffel returned test-mode offers; a live token is required for price snapshots');
  }
  return offers.map(function (offer) {
    var airline = flightOfferAirline_(offer);
    var stops = flightOfferStops_(offer);
    var price = flightOfferTwd_(offer);
    if (price === null || !flightAirlineAllowed_(airline, context.watch)) return null;
    if (context.watch.nonstopOnly && stops !== 0) return null;
    var leg = context.leg || 'full';
    if (leg !== 'full') {
      // 拼單程的單一航段（單程 offer 只有一個 slice）：先留著，等 combineDuffelSeparateRows_ 把去程 + 回程配對
      return {
        leg: leg,
        cabin: context.cabin,
        priceTWD: Math.round(price),
        airline: airline,
        stops: stops,
        details: flightDuffelSliceDetails_(offer.slices && offer.slices[0]),
      };
    }
    var outbound = flightDuffelSliceDetails_(offer.slices && offer.slices[0]);
    var inbound = flightDuffelSliceDetails_(offer.slices && offer.slices[1]);
    var row = {
      ticketing: 'single',
      cabin: context.cabin,
      departureDate: context.window.departure,
      returnDate: context.window.returning,
      priceTWD: Math.round(price),
      airline: airline,
      stops: stops,
      reason: 'Duffel 即時可售 offer；價格可能於 offer 到期後變動。',
    };
    var details = flightWindowDetails_({
      departureTime: outbound.departureTime,
      arrivalTime: outbound.arrivalTime,
      durationMinutes: outbound.durationMinutes,
      flightNumber: outbound.flightNumber,
      returnDepartureTime: inbound.departureTime,
      returnArrivalTime: inbound.arrivalTime,
    });
    Object.keys(details).forEach(function (key) { row[key] = details[key]; });
    return row;
  }).filter(function (offer) { return offer !== null; });
}

/**
 * 拼單程：同一艙等取最便宜的去程單程 + 最便宜的回程單程，組成一筆 ticketing 'separate' 的候選。
 * 兩張票各自獨立（行李、延誤不互保），所以 reason 會標示。
 */
function combineDuffelSeparateRows_(watch, window, legRows) {
  var out = [];
  flightWatchCabins_(watch).forEach(function (cabin) {
    var cheapest = function (leg) {
      return legRows
        .filter(function (row) { return row.leg === leg && row.cabin === cabin; })
        .sort(function (a, b) { return a.priceTWD - b.priceTWD; })[0];
    };
    var outbound = cheapest('outbound');
    var inbound = cheapest('return');
    if (!outbound || !inbound) return;
    var combined = {
      ticketing: 'separate',
      cabin: cabin,
      departureDate: window.departure,
      returnDate: window.returning,
      priceTWD: outbound.priceTWD + inbound.priceTWD,
      outboundPriceTWD: outbound.priceTWD,
      returnPriceTWD: inbound.priceTWD,
      airline: outbound.airline,
      returnAirline: inbound.airline,
      stops: Math.max(outbound.stops, inbound.stops),
      reason: '拼單程：去程與回程分開買兩張票；行李與延誤轉機不互保。',
    };
    var details = flightWindowDetails_({
      departureTime: outbound.details.departureTime,
      arrivalTime: outbound.details.arrivalTime,
      durationMinutes: outbound.details.durationMinutes,
      flightNumber: outbound.details.flightNumber,
      returnDepartureTime: inbound.details.departureTime,
      returnArrivalTime: inbound.details.arrivalTime,
    });
    Object.keys(details).forEach(function (key) { combined[key] = details[key]; });
    out.push(combined);
  });
  return out;
}

function flightMedian_(values) {
  if (!values.length) return 0;
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function buildDuffelEstimate_(watch, rows) {
  if (!rows.length) return null;
  var cabinEstimates = flightWatchCabins_(watch).map(function (cabin) {
    var cabinRows = rows.filter(function (row) { return row.cabin === cabin; })
      .sort(function (a, b) { return a.priceTWD - b.priceTWD; });
    if (!cabinRows.length) return null;
    return {
      cabin: cabin,
      minPriceTWD: cabinRows[0].priceTWD,
      typicalPriceTWD: Math.round(flightMedian_(cabinRows.map(function (row) { return row.priceTWD; }))),
      maxPriceTWD: cabinRows[cabinRows.length - 1].priceTWD,
      bestAirline: cabinRows[0].airline,
    };
  }).filter(function (item) { return item !== null; });
  if (!cabinEstimates.length) return null;
  var allPrices = rows.map(function (row) { return row.priceTWD; }).sort(function (a, b) { return a - b; });
  var minPrice = allPrices[0];
  var typicalPrice = Math.round(flightMedian_(allPrices));
  var advice = flightPriceAdvice_(watch, minPrice, typicalPrice);
  var airlines = {};
  rows.forEach(function (row) { if (row.airline) airlines[row.airline] = true; });
  return {
    minPriceTWD: minPrice,
    typicalPriceTWD: typicalPrice,
    maxPriceTWD: allPrices[allPrices.length - 1],
    confidence: rows.length >= 3 ? 'high' : 'medium',
    summary: 'Duffel Flights API 即時可售票價；每日輪替一組日期與晚數，逐步涵蓋設定範圍。',
    advice: advice.value,
    adviceReason: advice.reason + ' API offer 通常約 30 分鐘內有效，購票前仍需重新報價。',
    cabinEstimates: cabinEstimates,
    travelWindows: rows.slice().sort(function (a, b) { return a.priceTWD - b.priceTWD; }).slice(0, FLIGHT_MAX_TRAVEL_WINDOWS_),
    sources: [{
      title: 'Duffel Flights API · ' + Object.keys(airlines).slice(0, 5).join('、'),
      url: 'https://duffel.com/flights',
    }],
    checkedAt: new Date(),
  };
}

function scanFlightWatchDocsWithDuffel_(watches, notifyDeals) {
  if (!watches || watches.length === 0) return { ok: true, updated: 0, failed: 0, skipped: true, provider: 'duffel' };
  var token = PROP.getProperty('DUFFEL_ACCESS_TOKEN');
  if (!token) return { ok: false, error: 'DUFFEL_ACCESS_TOKEN not set', updated: 0, failed: watches.length };
  var requests = [];
  var contexts = [];
  try {
    watches.forEach(function (watch) {
      if (!/^[A-Z]{3}$/.test(String(watch.origin || '').toUpperCase()) || !/^[A-Z]{3}$/.test(String(watch.destination || '').toUpperCase())) {
        throw new Error('Duffel requires 3-letter IATA airport codes');
      }
      var duffelReturnLeg = flightReturnLeg_(watch);
      if (duffelReturnLeg && (!/^[A-Z]{3}$/.test(duffelReturnLeg.from) || !/^[A-Z]{3}$/.test(duffelReturnLeg.to))) {
        throw new Error('Duffel requires 3-letter IATA airport codes for the return leg');
      }
      var window = flightDuffelWindow_(watch);
      var mode = flightTicketSearch_(watch);
      var legs = mode === 'single' ? ['full'] : mode === 'separate' ? ['outbound', 'return'] : ['full', 'outbound', 'return'];
      flightWatchCabins_(watch).forEach(function (cabin) {
        legs.forEach(function (leg) {
          requests.push(flightDuffelRequest_(token, watch, cabin, window, leg));
          contexts.push({ watch: watch, cabin: cabin, window: window, leg: leg });
        });
      });
    });
    var usage = reserveFlightApiRequests_(requests.length);
    var responses = UrlFetchApp.fetchAll(requests);
    var rowsByWatch = {};
    var legRowsByWatch = {};
    var windowByWatch = {};
    contexts.forEach(function (context, index) {
      var id = flightWatchId_(context.watch);
      if (!rowsByWatch[id]) rowsByWatch[id] = [];
      if (!legRowsByWatch[id]) legRowsByWatch[id] = [];
      windowByWatch[id] = context.window;
      var response = responses[index];
      if (!response) throw new Error('Duffel response missing');
      var parsed = parseDuffelOffers_(response, context);
      if (context.leg && context.leg !== 'full') legRowsByWatch[id] = legRowsByWatch[id].concat(parsed);
      else rowsByWatch[id] = rowsByWatch[id].concat(parsed);
    });
    watches.forEach(function (watch) {
      var id = flightWatchId_(watch);
      if (!legRowsByWatch[id] || legRowsByWatch[id].length === 0) return;
      rowsByWatch[id] = (rowsByWatch[id] || []).concat(combineDuffelSeparateRows_(watch, windowByWatch[id], legRowsByWatch[id]));
    });
    var updated = 0;
    var failed = 0;
    var notifications = [];
    watches.forEach(function (watch) {
      try {
        var estimate = buildDuffelEstimate_(watch, rowsByWatch[flightWatchId_(watch)] || []);
        if (!estimate) throw new Error('Duffel did not return matching flight offers');
        saveFlightWatchEstimate_(watch, estimate);
        updated++;
        if (notifyDeals) {
          var isDeal = isFlightDeal_(watch, estimate);
          if (watch.notifyOnEveryScan === true || (watch.notifyOnDeal !== false && isDeal)) {
            notifications.push({ watch: watch, estimate: estimate, isDeal: isDeal });
          }
        }
      } catch (err) {
        failed++;
        saveFlightWatchError_(watch, err);
        console.error('Duffel flight scan', flightWatchId_(watch), err);
      }
    });
    if (notifications.length > 0) notifyFlightPrices_(notifications);
    return { ok: failed === 0, provider: 'duffel', requests: requests.length, monthlyUsage: usage.used, monthlyLimit: usage.limit, updated: updated, failed: failed };
  } catch (err) {
    watches.forEach(function (watch) { saveFlightWatchError_(watch, err); });
    return { ok: false, provider: 'duffel', error: String(err && err.message || err), updated: 0, failed: watches.length };
  }
}

function isFlightWatchDue_(watch, now) {
  var today = Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd');
  var lastDate = watch.lastCheckedAt instanceof Date
    ? Utilities.formatDate(watch.lastCheckedAt, 'Asia/Taipei', 'yyyy-MM-dd')
    : '';
  if (lastDate === today) return false;
  var taipeiDate = Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd');
  var weekday = new Date(taipeiDate + 'T12:00:00Z').getUTCDay();
  var isoWeekday = weekday === 0 ? 7 : weekday;
  if (watch.scanFrequency === 'weekdays') return isoWeekday >= 1 && isoWeekday <= 5;
  if (watch.scanFrequency === 'weekly') return weekday === Math.max(0, Math.min(6, Number(watch.weeklyDay) || 0));
  return true;
}

function flightTicketSearchText_(watch) {
  var mode = flightTicketSearch_(watch);
  if (flightTripType_(watch) === 'oneway') return '單程一張票';
  if (mode === 'separate') {
    return '只查「拼單程」：去程、回程各買一張單程（可不同航空公司），travelWindows 每筆填 ticketing="separate"、outboundPriceTWD、returnPriceTWD（priceTWD = 兩者相加），回程航空公司填 returnAirline';
  }
  if (mode === 'both') {
    return '一張票（' + (flightTripType_(watch) === 'openjaw' ? '多城市' : '來回') + '）與「拼單程」都要查：一張票 ticketing="single"；拼單程 ticketing="separate" 並填 outboundPriceTWD、returnPriceTWD（priceTWD = 兩者相加）、returnAirline。兩種都列進 travelWindows，讓我比較';
  }
  return '一張票（' + (flightTripType_(watch) === 'openjaw' ? '多城市' : '來回') + '），ticketing="single"';
}

function flightAiTripText_(watch) {
  var type = flightTripType_(watch);
  if (type === 'oneway') return '單程（只查去程，returnDate 留空字串）';
  if (type === 'openjaw') {
    var leg = flightReturnLeg_(watch);
    return '多點進出／open-jaw（去程 ' + watch.origin + ' → ' + watch.destination + '，回程 ' + leg.from + ' → ' + leg.to
      + '；請用多城市行程搜尋，returnDate = 回程航段出發日）';
  }
  return '來回';
}

function buildFlightWatchPrompt_(watch) {
  var cabins = flightWatchCabins_(watch);
  var airlineCodes = Array.isArray(watch.airlineCodes) ? watch.airlineCodes : [];
  var airlineRule = '不限航空公司';
  if (watch.airlineFilter === 'include' && airlineCodes.length > 0) {
    airlineRule = '只接受以下航空公司：' + airlineCodes.join('、');
  } else if (watch.airlineFilter === 'exclude' && airlineCodes.length > 0) {
    airlineRule = '排除以下航空公司：' + airlineCodes.join('、');
  }
  return [
    '今天是 ' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd') + '。',
    '請使用 web search 搜尋公開可見的近期機票價格（行程類型見下方），協助台灣旅客比較旅遊目的地。',
    '搜尋條件：',
    '- 出發機場或城市：' + watch.origin,
    '- 目的地：' + watch.destination,
    '- 行程：' + flightAiTripText_(watch),
    '- 可出發日期：' + formatFlightWatchDate_(watch.departureStart) + ' 到 ' + formatFlightWatchDate_(watch.departureEnd),
    flightTripType_(watch) === 'oneway' ? '- 旅程長度：不適用（單程）' : '- 旅程長度：' + watch.minNights + ' 到 ' + watch.maxNights + ' 晚',
    '- 成人：' + watch.adults + ' 人',
    '- 要分別比較的艙等：' + cabins.join('、'),
    '- 航班限制：' + (watch.nonstopOnly ? '僅直飛' : '可轉機'),
    '- 廉價航空：' + (watch.excludeLowCostCarriers ? '排除所有廉價航空，只接受傳統航空' : '可以納入'),
    '- 航空公司條件：' + airlineRule,
    '- 購票方式：' + flightTicketSearchText_(watch),
    '',
    '規則：',
    '1. 價格必須是所有旅客合計的含稅價格（' + flightTripTypeLabel_(watch) + (flightTripType_(watch) === 'openjaw' ? '，同一張多城市機票' : '') + '），統一換算為 TWD 整數。',
    '2. 優先採用航空公司、Google Flights、Skyscanner、KAYAK 或可信 OTA 的近期搜尋結果。',
    '   請實際執行 web search（最多 ' + FLIGHT_CLAUDE_MAX_SEARCHES_ + ' 次），並用 1 到 3 組符合晚數的具體日期搜尋；可使用具公開來源的指示價，不要因為搜尋頁需互動才查價就直接判定沒有資料。',
    '3. 不可把單程價當來回價（或反過來），多點進出不可用兩張單程或一般來回價代替，不可自行臆測；資料不足時 available=false。',
    '   travelWindows 可附 departureTime、arrivalTime（HH:mm 當地時間）、durationMinutes、flightNumber，查不到就省略。',
    '4. 每個指定艙等都必須在 cabinEstimates 各自列出，不能把經濟艙價格誤當商務艙；找不到可靠價格的艙等可以省略。',
    '5. travelWindows 列出最多 12 組範圍內實際查到的出發/回程日期，盡量分散在整個可出發範圍的不同週與不同晚數（不要只列最便宜的同一週），包含艙等、航空公司、轉機次數與所有旅客合計價格。',
    '6. 嚴格遵守排除廉航、直飛與航空公司條件；無法確認符合條件時 available=false，不可拿不符合條件的便宜價格代替。',
    '7. minPriceTWD 是較便宜但合理可見的價格，typicalPriceTWD 是常見價，maxPriceTWD 是偏高價，不是絕對最低或最高。',
    '8. summary 與 priceReason 各用 100 字內繁體中文，說明日期彈性、艙等價差、行李或資料限制。',
    '9. 搜尋完成後，最後的回覆只輸出一個合法 JSON object，不要 Markdown code fence 或其他文字。',
    '',
    'JSON 格式：',
    '{"available":true,"confidence":"low|medium|high","summary":"...","priceReason":"...","cabinEstimates":[{"cabin":"economy","minPriceTWD":12000,"typicalPriceTWD":16000,"maxPriceTWD":22000,"bestAirline":"BR 長榮航空"},{"cabin":"business","minPriceTWD":42000,"typicalPriceTWD":52000,"maxPriceTWD":68000,"bestAirline":"CI 中華航空"}],"travelWindows":[{"departureDate":"2026-11-04","returnDate":"2026-11-10","cabin":"economy","priceTWD":12000,"airline":"BR 長榮航空","stops":0,"reason":"平日出發較便宜"}]}',
  ].concat(flightTicketSearch_(watch) !== 'single' ? [
    '拼單程的 travelWindows 項目範例：{"ticketing":"separate","departureDate":"2026-11-04","returnDate":"2026-11-10","cabin":"economy","priceTWD":10500,"outboundPriceTWD":5200,"returnPriceTWD":5300,"airline":"IT 台灣虎航","returnAirline":"MM 樂桃航空","stops":0,"reason":"兩張單程比多城市票便宜"}',
  ] : []).join('\n');
}

/**
 * 解析 AI 搜尋回應。支援 Claude Messages API（content blocks + web_search_tool_result）
 * 與舊版 Gemini（candidates + groundingMetadata，保留給測試 / 舊資料重算）。
 */
function parseFlightWatchResponse_(responseText, watch) {
  var data = JSON.parse(responseText);
  if (Array.isArray(data.content)) return parseFlightWatchClaudeResponse_(data, watch);
  var candidates = data.candidates || [];
  if (candidates.length === 0) throw new Error('AI 沒有回傳可用的票價候選結果');
  var raw = null;
  var sources = [];
  candidates.forEach(function (candidate) {
    sources = mergeFlightWatchSources_(sources, flightWatchSources_(candidate));
    if (raw) return;
    var parts = (candidate.content && candidate.content.parts) || [];
    // Gemini 2.5/3 may put internal thought text in a separate part. Joining it
    // with the final JSON makes an otherwise valid grounded response unparseable.
    var visibleTexts = parts.filter(function (part) {
      return part && part.thought !== true && typeof part.text === 'string';
    }).map(function (part) { return part.text; });
    raw = extractFlightWatchJson_(visibleTexts);
  });
  return finishFlightWatchParse_(raw, sources, watch, 'Gemini');
}

function parseFlightWatchClaudeResponse_(data, watch) {
  var blocks = data.content || [];
  // 只取最後一次 web search 結果之後的 text（之前的是搜尋過程的說明）
  var lastToolIndex = -1;
  blocks.forEach(function (block, index) {
    if (block && (block.type === 'web_search_tool_result' || block.type === 'server_tool_use')) lastToolIndex = index;
  });
  var finalTexts = blocks.slice(lastToolIndex + 1)
    .filter(function (block) { return block && block.type === 'text' && typeof block.text === 'string'; })
    .map(function (block) { return block.text; });
  var raw = extractFlightWatchJson_(finalTexts);
  if (!raw) {
    raw = extractFlightWatchJson_(blocks
      .filter(function (block) { return block && block.type === 'text' && typeof block.text === 'string'; })
      .map(function (block) { return block.text; }));
  }
  return finishFlightWatchParse_(raw, flightWatchClaudeSources_(blocks), watch, 'Claude');
}

function finishFlightWatchParse_(raw, sources, watch, label) {
  if (!raw) throw new Error(label + ' 已搜尋，但回傳的票價格式無法解析，請再試一次');
  if (raw.available !== true && String(raw.available).toLowerCase() !== 'true') {
    var unavailableReason = String(raw.reason || raw.priceReason || '').slice(0, 160);
    throw new Error('公開搜尋暫無可用票價' + (unavailableReason ? '：' + unavailableReason : ''));
  }
  if (sources.length === 0) {
    throw new Error(label + ' 已回傳票價，但沒有附上可驗證的公開來源');
  }
  return buildFlightEstimateFromRaw_(raw, sources, watch, label);
}

/** Claude 回應的來源：text block 的 citations 優先，其次 web_search_tool_result 的搜尋結果 */
function flightWatchClaudeSources_(blocks) {
  var seen = {};
  var cited = [];
  var searched = [];
  function push(list, url, title) {
    if (!url || seen[url] || !/^https?:\/\//i.test(url)) return;
    seen[url] = true;
    list.push({ title: String(title || url).slice(0, 160), url: url });
  }
  (blocks || []).forEach(function (block) {
    if (!block) return;
    if (block.type === 'text') {
      (block.citations || []).forEach(function (c) { push(cited, c && c.url, c && c.title); });
    } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      block.content.forEach(function (r) {
        if (r && r.type === 'web_search_result') push(searched, r.url, r.title);
      });
    }
  });
  return cited.concat(searched).slice(0, 5);
}

/**
 * 把模型整理的 raw 結果（cabinEstimates / travelWindows / confidence / summary）轉成要保存的 estimate。
 * Claude API 搜尋與 Claude 排程共用：艙等、日期、晚數、直飛、航空公司條件都在這裡再驗一次，
 * advice 一律由程式決定，不採用模型的購買建議。
 */
function buildFlightEstimateFromRaw_(raw, sources, watch, providerLabel) {
  var requestedCabins = flightWatchCabins_(watch);
  var cabinEstimates = (Array.isArray(raw.cabinEstimates) ? raw.cabinEstimates : [])
    .map(function (item) { return parseFlightCabinEstimate_(item, requestedCabins, watch); })
    .filter(function (item) { return item !== null; });
  var prices;
  if (cabinEstimates.length > 0) {
    prices = [
      Math.min.apply(null, cabinEstimates.map(function (item) { return item.minPriceTWD; })),
      Math.min.apply(null, cabinEstimates.map(function (item) { return item.typicalPriceTWD; })),
      Math.max.apply(null, cabinEstimates.map(function (item) { return item.maxPriceTWD; })),
    ];
  } else {
    prices = [
      flightWatchPrice_(raw.minPriceTWD),
      flightWatchPrice_(raw.typicalPriceTWD),
      flightWatchPrice_(raw.maxPriceTWD),
    ].filter(function (value) { return value !== null; }).sort(function (a, b) { return a - b; });
  }
  if (prices.length !== 3 || prices[0] < 1000 || prices[2] > 10000000) {
    throw new Error(providerLabel + ' 回傳的票價區間不完整或數值不合理');
  }

  var travelWindows = (Array.isArray(raw.travelWindows) ? raw.travelWindows : [])
    .map(function (item) { return parseFlightTravelWindow_(item, requestedCabins, watch); })
    .filter(function (item) { return item !== null; })
    .sort(function (a, b) { return a.priceTWD - b.priceTWD; })
    .slice(0, FLIGHT_MAX_TRAVEL_WINDOWS_);

  var confidence = raw.confidence;
  if (confidence !== 'high' && confidence !== 'medium') confidence = 'low';
  if (sources.length === 1 && confidence === 'high') confidence = 'medium';
  var advice = flightPriceAdvice_(watch, prices[0], prices[1]);
  return {
    minPriceTWD: Math.round(prices[0]),
    typicalPriceTWD: Math.round(prices[1]),
    maxPriceTWD: Math.round(prices[2]),
    confidence: confidence,
    summary: String(raw.summary || '公開搜尋票價區間，實際售價請向供應商確認。').slice(0, 240),
    advice: advice.value,
    adviceReason: advice.reason + (raw.priceReason ? ' ' + String(raw.priceReason).slice(0, 160) : ''),
    cabinEstimates: cabinEstimates,
    travelWindows: travelWindows,
    sources: sources,
    checkedAt: new Date(),
  };
}

function extractFlightWatchJson_(texts) {
  var attempts = [];
  if (texts.length > 0) attempts.push(texts.join('').trim());
  texts.slice().reverse().forEach(function (text) { attempts.push(String(text || '').trim()); });
  for (var i = 0; i < attempts.length; i++) {
    var cleaned = attempts[i].replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    var variants = [cleaned];
    var firstBrace = cleaned.indexOf('{');
    var lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) variants.push(cleaned.slice(firstBrace, lastBrace + 1));
    for (var j = 0; j < variants.length; j++) {
      try {
        var parsed = JSON.parse(variants[j]);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch (err) {
        // Try the next final-text part/JSON boundary. A detailed user-facing
        // error is emitted only after every safe extraction strategy fails.
      }
    }
  }
  return null;
}

/** 單程、來回或多點進出（openjaw）；舊資料沒有 tripType 一律視為來回 */
function flightTripType_(watch) {
  if (watch && watch.tripType === 'oneway') return 'oneway';
  if (watch && watch.tripType === 'openjaw') return 'openjaw';
  return 'roundtrip';
}

/**
 * 回程航段機場。來回 = destination → origin；多點進出（A 進 B 出）= returnOrigin → returnDestination
 * （缺值時退回來回的機場）；單程回傳 null。前端同邏輯在 flight-watches/types.ts（flightReturnLeg）。
 */
function flightReturnLeg_(watch) {
  var type = flightTripType_(watch);
  if (type === 'oneway') return null;
  var origin = String(watch.origin || '').trim().toUpperCase();
  var destination = String(watch.destination || '').trim().toUpperCase();
  if (type === 'openjaw') {
    return {
      from: String(watch.returnOrigin || '').trim().toUpperCase() || destination,
      to: String(watch.returnDestination || '').trim().toUpperCase() || origin,
    };
  }
  return { from: destination, to: origin };
}

function flightTripTypeLabel_(watch) {
  var type = flightTripType_(watch);
  if (type === 'oneway') return '單程';
  if (type === 'openjaw') return '多點進出';
  return '來回';
}

/**
 * 購票方式：single = 一張票（來回 / 多城市），separate = 兩張單程拼起來，both = 兩種都查、取較便宜。
 * 預設：多點進出 both（拼單程常常比多城市票便宜或才查得到）、來回 single（維持舊行為）。單程不適用。
 * 前端同邏輯在 flight-watches/types.ts（flightTicketSearch）。
 */
function flightTicketSearch_(watch) {
  var type = flightTripType_(watch);
  if (type === 'oneway') return 'single';
  var value = watch && watch.ticketSearch;
  if (value === 'single' || value === 'separate' || value === 'both') return value;
  return type === 'openjaw' ? 'both' : 'single';
}

function flightTicketSearchDefault_(watch) {
  return flightTripType_(watch) === 'openjaw' ? 'both' : 'single';
}

/** Telegram / 提示詞用的航線文字：「TPE → NRT」或「TPE → NRT ／ KIX → TPE」 */
function flightRouteText_(watch) {
  var outbound = String(watch.origin || '') + ' → ' + String(watch.destination || '');
  if (flightTripType_(watch) !== 'openjaw') return outbound;
  var leg = flightReturnLeg_(watch);
  return outbound + ' ／ ' + leg.from + ' → ' + leg.to;
}

/** 航班細節（選填）：時間 HH:mm、飛行分鐘數、航班號。格式不對就丟掉，不影響整筆結果 */
function flightWindowDetails_(item) {
  var details = {};
  var timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  ['departureTime', 'arrivalTime', 'returnDepartureTime', 'returnArrivalTime'].forEach(function (key) {
    var value = String((item && item[key]) || '').trim();
    if (timePattern.test(value)) details[key] = value;
  });
  var duration = Math.round(Number(item && item.durationMinutes));
  if (isFinite(duration) && duration >= 20 && duration <= 3000) details.durationMinutes = duration;
  var flightNumber = String((item && item.flightNumber) || '').toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(flightNumber)) details.flightNumber = flightNumber;
  return details;
}

function flightWatchCabins_(watch) {
  var valid = { economy: true, premium_economy: true, business: true, first: true };
  var cabins = Array.isArray(watch && watch.selectedCabins)
    ? watch.selectedCabins.filter(function (cabin) { return valid[cabin] === true; })
    : [];
  if (cabins.length === 0) cabins = [valid[watch && watch.cabin] ? watch.cabin : 'economy'];
  return cabins;
}

function parseFlightCabinEstimate_(item, requestedCabins, watch) {
  if (!item || requestedCabins.indexOf(item.cabin) === -1) return null;
  if (!flightAirlineAllowed_(item.bestAirline, watch)) return null;
  var prices = [
    flightWatchPrice_(item.minPriceTWD),
    flightWatchPrice_(item.typicalPriceTWD),
    flightWatchPrice_(item.maxPriceTWD),
  ].filter(function (value) { return value !== null; }).sort(function (a, b) { return a - b; });
  if (prices.length !== 3 || prices[0] < 1000 || prices[2] > 10000000) return null;
  return {
    cabin: item.cabin,
    minPriceTWD: Math.round(prices[0]),
    typicalPriceTWD: Math.round(prices[1]),
    maxPriceTWD: Math.round(prices[2]),
    bestAirline: String(item.bestAirline || '').slice(0, 100),
  };
}

function parseFlightTravelWindow_(item, requestedCabins, watch) {
  if (!item || requestedCabins.indexOf(item.cabin) === -1) return null;
  if (!flightAirlineAllowed_(item.airline, watch)) return null;
  var price = flightWatchPrice_(item.priceTWD);
  var datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (price === null || price < 1000 || price > 10000000) return null;
  var oneway = flightTripType_(watch) === 'oneway';
  if (!datePattern.test(String(item.departureDate || ''))) return null;
  if (!oneway && !datePattern.test(String(item.returnDate || ''))) return null;
  var departure = new Date(String(item.departureDate) + 'T00:00:00+08:00');
  if (isNaN(departure.getTime())) return null;
  if (watch.departureStart instanceof Date && departure < watch.departureStart) return null;
  if (watch.departureEnd instanceof Date && departure > watch.departureEnd) return null;
  if (!oneway) {
    var returning = new Date(String(item.returnDate) + 'T00:00:00+08:00');
    var nights = Math.round((returning.getTime() - departure.getTime()) / 86400000);
    if (isNaN(returning.getTime())) return null;
    if (nights < Number(watch.minNights || 1) || nights > Number(watch.maxNights || 90)) return null;
  }
  var stops = Math.max(0, Math.min(4, Math.round(Number(item.stops) || 0)));
  if (watch.nonstopOnly && stops !== 0) return null;
  var travelWindow = {
    departureDate: String(item.departureDate),
    returnDate: oneway ? '' : String(item.returnDate),
    cabin: item.cabin,
    priceTWD: Math.round(price),
    airline: String(item.airline || '').slice(0, 100),
    stops: stops,
    reason: String(item.reason || '').slice(0, 160),
  };
  var details = flightWindowDetails_(item);
  if (oneway) {
    delete details.returnDepartureTime;
    delete details.returnArrivalTime;
  }
  Object.keys(details).forEach(function (key) { travelWindow[key] = details[key]; });
  var ticketing = flightWindowTicketing_(item, watch);
  if (ticketing === null) return null;
  Object.keys(ticketing).forEach(function (key) { travelWindow[key] = ticketing[key]; });
  // 拼單程的總價一律 = 兩段相加，避免模型自己加錯
  if (ticketing.ticketing === 'separate') travelWindow.priceTWD = ticketing.outboundPriceTWD + ticketing.returnPriceTWD;
  return travelWindow;
}

/**
 * 購票方式欄位：separate 必須有兩段價格（各 ≥ 500）且加總與 priceTWD 差距 ≤ 5%，否則整筆捨棄；
 * 只查一張票的航線收到 separate、或只查拼單程的航線收到 single 也捨棄。單程一律 single。
 * 回傳 null = 捨棄；{} = 舊格式沒標示（視為 single）。
 */
function flightWindowTicketing_(item, watch) {
  var mode = flightTicketSearch_(watch);
  var ticketing = item && item.ticketing === 'separate' ? 'separate' : item && item.ticketing === 'single' ? 'single' : '';
  if (flightTripType_(watch) === 'oneway') return ticketing === 'separate' ? null : {};
  if (ticketing === 'separate') {
    if (mode === 'single') return null;
    var outboundPrice = flightWatchPrice_(item.outboundPriceTWD);
    var returnPrice = flightWatchPrice_(item.returnPriceTWD);
    if (outboundPrice === null || returnPrice === null || outboundPrice < 500 || returnPrice < 500) return null;
    var sum = Math.round(outboundPrice) + Math.round(returnPrice);
    var claimed = flightWatchPrice_(item.priceTWD);
    if (claimed !== null && Math.abs(claimed - sum) > sum * 0.05) return null;
    var out = { ticketing: 'separate', outboundPriceTWD: Math.round(outboundPrice), returnPriceTWD: Math.round(returnPrice) };
    var returnAirline = String(item.returnAirline || '').slice(0, 100);
    if (returnAirline) {
      if (!flightAirlineAllowed_(returnAirline, watch)) return null;
      out.returnAirline = returnAirline;
    }
    return out;
  }
  if (mode === 'separate' && ticketing === 'single') return null;
  return ticketing === 'single' ? { ticketing: 'single' } : {};
}

function flightAirlineAllowed_(airline, watch) {
  var text = String(airline || '').toLowerCase();
  var codes = Array.isArray(watch && watch.airlineCodes) ? watch.airlineCodes : [];
  var matchesConfigured = codes.some(function (code) {
    var normalized = String(code).trim().toLowerCase();
    if (!normalized) return false;
    if (/^[a-z0-9]{2,3}$/.test(normalized)) {
      var escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)').test(text);
    }
    return text.indexOf(normalized) !== -1;
  });
  if (watch && watch.airlineFilter === 'include' && !matchesConfigured) return false;
  if (watch && watch.airlineFilter === 'exclude' && matchesConfigured) return false;
  if (watch && watch.excludeLowCostCarriers) {
    var lowCostTokens = [
      'airasia', 'scoot', 'tigerair', 'peach', 'jetstar', 'vietjet', 'cebu pacific', 'zipair',
      '酷航', '虎航', '樂桃', '捷星', '亞洲航空', '越捷', '宿霧太平洋',
    ];
    if (lowCostTokens.some(function (token) { return text.indexOf(token) !== -1; })) return false;
  }
  return true;
}

function flightPriceAdvice_(watch, minPrice, typicalPrice) {
  var previous = watch && watch.latestEstimate && Number(watch.latestEstimate.minPriceTWD);
  if ((typeof watch.maxPriceTWD === 'number' && minPrice <= watch.maxPriceTWD)
      || minPrice <= typicalPrice * 0.85) {
    return { value: 'buy_now', reason: '目前較低價已落在理想價或明顯低於常見區間。' };
  }
  if (previous && minPrice >= previous * 1.08) {
    return { value: 'wait', reason: '目前較低價比上次掃描上漲至少 8%，可先等待下一次更新。' };
  }
  return { value: 'watch', reason: '目前價格未達明顯低價門檻，建議持續觀察每日變化。' };
}

function flightWatchSources_(candidate) {
  var seen = {};
  var sources = [];
  var metadata = candidate && candidate.groundingMetadata;
  ((metadata && metadata.groundingChunks) || []).forEach(function (chunk) {
    var web = chunk && chunk.web;
    if (!web || !web.uri || seen[web.uri]) return;
    seen[web.uri] = true;
    sources.push({ title: String(web.title || web.uri).slice(0, 160), url: web.uri });
  });
  ((candidate && candidate.citationMetadata && candidate.citationMetadata.citations) || []).forEach(function (citation) {
    var uri = citation && citation.uri;
    if (!uri || seen[uri]) return;
    seen[uri] = true;
    sources.push({ title: String(citation.title || uri).slice(0, 160), url: uri });
  });
  return sources.slice(0, 5);
}

function mergeFlightWatchSources_(current, incoming) {
  var seen = {};
  return current.concat(incoming).filter(function (source) {
    if (!source || !source.url || seen[source.url]) return false;
    seen[source.url] = true;
    return true;
  }).slice(0, 5);
}

function flightWatchPrice_(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  var parsed = Number(value.replace(/[^0-9.]/g, ''));
  return isFinite(parsed) ? parsed : null;
}

function saveFlightWatchEstimate_(watch, estimate, opts) {
  var id = flightWatchId_(watch);
  if (!id) throw new Error('flight watch id missing');
  var previousBest = typeof watch.bestPriceTWD === 'number' ? watch.bestPriceTWD : null;
  // 可疑價格（例如外部推送的異常低價）仍保存快照供檢視，但不更新歷史最低價。
  var nextBest = opts && opts.skipBestPrice === true
    ? previousBest
    : previousBest === null ? estimate.minPriceTWD : Math.min(previousBest, estimate.minPriceTWD);
  fsSetDoc_('flight_watches/' + id, {
    latestEstimate: estimate,
    bestPriceTWD: nextBest,
    lastCheckedAt: estimate.checkedAt,
    lastError: null,
    updatedAt: estimate.checkedAt,
  }, true);
  var snapshotId = Utilities.formatDate(estimate.checkedAt, 'Asia/Taipei', 'yyyyMMdd-HHmmss');
  fsSetDoc_('flight_watches/' + id + '/snapshots/' + snapshotId, estimate, false);
}

function saveFlightWatchError_(watch, err) {
  var id = flightWatchId_(watch);
  if (!id) return;
  var now = new Date();
  fsSetDoc_('flight_watches/' + id, {
    lastCheckedAt: now,
    lastError: String(err && err.message || err).slice(0, 500),
    updatedAt: now,
  }, true);
}

function flightWatchId_(watch) {
  return String((watch && watch._name) || '').split('/').pop();
}

function formatFlightWatchDate_(date) {
  return date instanceof Date ? Utilities.formatDate(date, 'Asia/Taipei', 'yyyy-MM-dd') : String(date || '');
}

function isFlightDeal_(watch, estimate) {
  var previous = watch.latestEstimate && Number(watch.latestEstimate.minPriceTWD);
  var crossedTarget = typeof watch.maxPriceTWD === 'number'
    && estimate.minPriceTWD <= watch.maxPriceTWD
    && (!previous || previous > watch.maxPriceTWD);
  var dropPercent = Math.max(1, Math.min(50, Number(watch.priceDropPercent) || 5));
  var meaningfulDrop = previous && estimate.minPriceTWD <= previous * (1 - dropPercent / 100);
  return Boolean(crossedTarget || meaningfulDrop);
}

/**
 * 機票通知依訂閱者分流：
 * - owner（或舊資料沒有 userId）→ 原本的 sendNotification_('flightDeals')（受通知設定開關控制）
 * - 共同帳本伴侶（role member，2026-11 開放機票雷達）→ 他自己綁定的 telegram_links/{uid}.chatId；
 *   沒綁 Telegram 就不發（不能發到 owner 的 chat，那是別人的訂閱）。
 */
function notifyFlightPrices_(items) {
  var byUser = {};
  var order = [];
  (items || []).forEach(function (item) {
    var uid = String((item.watch && item.watch.userId) || '');
    if (!byUser[uid]) { byUser[uid] = []; order.push(uid); }
    byUser[uid].push(item);
  });
  var results = order.map(function (uid) {
    var chatId = uid ? flightMemberChatId_(uid) : null;
    if (chatId === false) return { ok: false, skipped: true, reason: 'member-telegram-not-linked' };
    var message = flightPriceMessage_(byUser[uid]);
    return chatId ? sendTelegramToChat_(chatId, message) : sendNotification_('flightDeals', message);
  });
  return results.length === 1 ? results[0] : { ok: results.every(function (r) { return r && r.ok; }), results: results };
}

/** member → 綁定的 chatId（沒綁回 false）；owner / 查不到 → null（走 owner 的通知管道） */
function flightMemberChatId_(uid) {
  var user = null;
  try { user = fsGetDoc_('users/' + uid); } catch (err) { console.warn('flight notify user lookup', err); }
  if (!user || user.role !== 'member') return null;
  var link = null;
  try { link = fsGetDoc_('telegram_links/' + uid); } catch (ignoredErr) { console.warn('[FlightWatches:1078] ignored', ignoredErr); }
  return link && link.chatId ? String(link.chatId) : false;
}

function flightPriceMessage_(items) {
  var lines = ['[Personal Hub] 機票價格雷達', '--------------------'];
  items.forEach(function (item) {
    var watch = item.watch;
    var estimate = item.estimate;
    lines.push(flightRouteText_(watch)
      + '（' + flightTripTypeLabel_(watch) + '）'
      + (watch.segmentLabel ? ' · ' + watch.segmentLabel : ''));
    lines.push(item.isDeal ? '狀態：掃描到低價' : '狀態：排程價格回報');
    lines.push('較低價 NT$' + Math.round(estimate.minPriceTWD).toLocaleString()
      + '｜常見 NT$' + Math.round(estimate.typicalPriceTWD).toLocaleString());
    (estimate.cabinEstimates || []).slice(0, 4).forEach(function (cabin) {
      lines.push(flightCabinLabel_(cabin.cabin) + ' NT$' + Math.round(cabin.minPriceTWD).toLocaleString()
        + (cabin.bestAirline ? '｜' + cabin.bestAirline : ''));
    });
    if (estimate.travelWindows && estimate.travelWindows[0]) {
      var best = estimate.travelWindows[0];
      lines.push('推薦日期 ' + best.departureDate + (best.returnDate ? ' → ' + best.returnDate : '')
        + (best.departureTime ? ' ' + best.departureTime : '')
        + (best.flightNumber ? ' ' + best.flightNumber : '')
        + '｜' + flightCabinLabel_(best.cabin) + '｜NT$' + Math.round(best.priceTWD).toLocaleString());
    }
    if (watch.maxPriceTWD) lines.push('理想價上限 NT$' + Math.round(watch.maxPriceTWD).toLocaleString());
    lines.push(estimate.adviceReason || estimate.summary);
    if (estimate.sources[0]) lines.push(estimate.sources[0].url);
    lines.push('');
  });
  lines.push('公開搜尋估價，購票前請確認日期、行李與即時庫存。');
  return lines.join('\n');
}

function flightCabinLabel_(cabin) {
  var labels = {
    economy: '經濟艙',
    premium_economy: '豪華經濟艙',
    business: '商務艙',
    first: '頭等艙',
  };
  return labels[cabin] || String(cabin || '艙等');
}
