/**
 * 共同帳本 × Telegram
 *
 * 1. 綁定：成員在 /shared → 設定 → Telegram 按「連結 Telegram」（或 owner 替伴侶產生連結）
 *    → createTelegramLink 產生一次性 token（24h、單次使用）→ 開 https://t.me/{bot}?start={token}
 *    → 使用者在 Telegram 按 Start，bot 收到 `/start {token}` → 寫
 *        telegram_links/{uid}      { chatId, householdId, username, firstName, linkedAt }
 *        telegram_chats/{chatId}   { uid, householdId }   （webhook 用 chatId 反查身分）
 *        households/{hid}.telegramLinked[uid] = true       （純 UI 鏡像，讓 owner 看到對方有沒有連上）
 *    三份都只有 Apps Script（admin 權限）寫得進去；rules 一律 write: false，避免有人把自己的 chat 掛到別人帳號上。
 *
 * 2. 權限：綁定後的非 owner chat 只能用「共同帳本」指令（/report /invest /help /unlink），
 *    owner 原本的記帳 / 查帳指令（/balance、自由文字記帳…）一律不開放 —— 那些是讀寫 owner 全部資料的。
 *
 * 3. 報告：households/{hid}.householdReport = { enabled, frequency, includeLedger, includeInvestments }
 *    每天 21:00（tick_daily_2100）跑 runHouseholdReports()：daily 每天、weekly 週日、monthly 每月 1 號，
 *    發給每位已綁定的成員；owner 沒綁定時退回 TG_CHAT_ID。報告內容不含任何成員的個人帳戶 / 淨值。
 */

var HH_TG_TOKEN_TTL_MS_ = 24 * 60 * 60 * 1000;

function hhTgBotUsername_() {
  var cached = PROP.getProperty('TG_BOT_USERNAME');
  if (cached) return cached;
  var me = tgApi_('getMe', {});
  var username = me && me.ok && me.result && me.result.username;
  if (!username) throw new Error('無法取得 bot 名稱，請確認 TG_BOT_TOKEN');
  PROP.setProperty('TG_BOT_USERNAME', username);
  return username;
}

/**
 * 產生綁定連結。
 * body: { householdId, forUid? }；forUid 省略 = 自己。替別人產生只限 household owner。
 */
function createTelegramLink(body, authResult) {
  var hid = String((body && body.householdId) || '');
  var hh = hhRequireMember_(hid, authResult);
  var targetUid = String((body && body.forUid) || authResult.uid);
  if (targetUid !== authResult.uid && hh.ownerId !== authResult.uid) {
    return { ok: false, error: '只有建立者可以替其他成員產生連結' };
  }
  if (hh.memberIds.indexOf(targetUid) < 0) return { ok: false, error: '對方不是這個共同帳本的成員' };

  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  var expiresAt = new Date(Date.now() + HH_TG_TOKEN_TTL_MS_);
  fsSetDoc_('telegram_link_tokens/' + token, {
    uid: targetUid,
    householdId: hid,
    createdBy: authResult.uid,
    expiresAt: expiresAt,
    createdAt: new Date(),
  }, false);
  var username = hhTgBotUsername_();
  return {
    ok: true,
    url: 'https://t.me/' + username + '?start=' + token,
    botUsername: username,
    expiresAt: expiresAt.toISOString(),
  };
}

/** 解除自己的綁定（或 owner 解除成員的） */
function unlinkTelegram(body, authResult) {
  var hid = String((body && body.householdId) || '');
  var hh = hhRequireMember_(hid, authResult);
  var targetUid = String((body && body.forUid) || authResult.uid);
  if (targetUid !== authResult.uid && hh.ownerId !== authResult.uid) {
    return { ok: false, error: '只有建立者可以解除其他成員的綁定' };
  }
  hhTgRemoveLink_(targetUid);
  return { ok: true };
}

function hhTgRemoveLink_(uid) {
  var link = fsGetDoc_('telegram_links/' + uid);
  if (link && link.chatId) {
    try { fsDeleteDoc_('telegram_chats/' + link.chatId); } catch (err) { console.warn('unlink chat', err); }
  }
  try { fsDeleteDoc_('telegram_links/' + uid); } catch (err) { console.warn('unlink link', err); }
  if (link && link.householdId) hhTgSetLinkedMirror_(link.householdId, uid, false);
}

function hhTgSetLinkedMirror_(hid, uid, linked) {
  try {
    var hh = fsGetDoc_('households/' + hid);
    if (!hh) return;
    var map = (hh.telegramLinked && typeof hh.telegramLinked === 'object') ? hh.telegramLinked : {};
    if (linked) map[uid] = true; else delete map[uid];
    fsSetDoc_('households/' + hid, { telegramLinked: map }, true);
  } catch (err) {
    console.warn('hhTgSetLinkedMirror_', err);
  }
}

/** webhook：`/start {token}` → 綁定。回傳要回覆的文字。 */
function hhTgHandleStart_(chatId, token, from) {
  if (!/^[a-f0-9]{40}$/.test(token)) return '連結無效，請回 RMoney 重新產生。';
  var rec = fsGetDoc_('telegram_link_tokens/' + token);
  if (!rec) return '這個連結已經用過或不存在，請回 RMoney「共同 → 設定 → Telegram」重新產生。';
  try { fsDeleteDoc_('telegram_link_tokens/' + token); } catch (err) { console.warn('token delete', err); }
  if (!rec.expiresAt || new Date(rec.expiresAt).getTime() < Date.now()) {
    return '這個連結已過期（24 小時），請回 RMoney 重新產生。';
  }
  var hh = fsGetDoc_('households/' + rec.householdId);
  if (!hh || !Array.isArray(hh.memberIds) || hh.memberIds.indexOf(rec.uid) < 0) {
    return '你已經不在這個共同帳本裡，無法連結。';
  }
  // 同一個 chat 之前綁過別人 → 先解除舊綁定；同一個 uid 之前綁過別的 chat → 也先解除
  var prevChat = fsGetDoc_('telegram_chats/' + chatId);
  if (prevChat && prevChat.uid && prevChat.uid !== rec.uid) hhTgRemoveLink_(prevChat.uid);
  hhTgRemoveLink_(rec.uid);

  fsSetDoc_('telegram_links/' + rec.uid, {
    chatId: String(chatId),
    householdId: rec.householdId,
    username: (from && from.username) || '',
    firstName: (from && from.first_name) || '',
    linkedAt: new Date(),
  }, false);
  fsSetDoc_('telegram_chats/' + chatId, { uid: rec.uid, householdId: rec.householdId, linkedAt: new Date() }, false);
  hhTgSetLinkedMirror_(rec.householdId, rec.uid, true);

  var name = (hh.members && hh.members[rec.uid] && hh.members[rec.uid].displayName) || '';
  return [
    '已連結 RMoney' + (name ? '，' + name : '') + '！',
    '之後會在這裡收到「' + (hh.name || '共同帳本') + '」的共同支出與共同投資報告。',
    '',
    hhTgMemberHelp_(),
  ].join('\n');
}

function hhTgMemberHelp_() {
  return [
    '共同帳本指令：',
    '/report — 共同帳本完整報告（支出 + 投資）',
    '/invest — 共同投資現況',
    '/unlink — 停止接收並解除連結',
    '/help — 指令清單',
  ].join('\n');
}

/**
 * webhook：非 owner chat 的訊息。只處理已綁定的 chat，其餘一律忽略（不回覆，避免被當成 bot 探測）。
 * 回傳 null = 不是綁定的 chat。
 */
function hhTgHandleMemberMessage_(chatId, text) {
  var link = fsGetDoc_('telegram_chats/' + chatId);
  if (!link || !link.uid) return null;
  var cmd = String(text || '').trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  try {
    switch (cmd) {
      case '/report': return buildHouseholdReport_(link.householdId, { includeLedger: true, includeInvestments: true, title: '共同帳本報告' });
      case '/invest': return buildHouseholdReport_(link.householdId, { includeLedger: false, includeInvestments: true, title: '共同投資現況' });
      case '/unlink':
      case '/stop':
        hhTgRemoveLink_(link.uid);
        return '已解除連結，不會再收到共同帳本報告。要再接收請回 RMoney 重新連結。';
      case '/help':
      case '/start':
        return hhTgMemberHelp_();
      default:
        return '這個帳號只能查看共同帳本。\n\n' + hhTgMemberHelp_();
    }
  } catch (err) {
    console.error('hhTgHandleMemberMessage_', err);
    try { logErrorToFirestore_('hhTgMember', err, { cmd: cmd }); } catch (ignoredErr) { console.warn('[HouseholdTelegram:167] ignored', ignoredErr); }
    return '查詢失敗，請稍後再試。';
  }
}

// -------- 報告 --------

function hhSign_(n) { return (n >= 0 ? '+' : '−') + 'NT$' + n0(Math.abs(n)); }
function hhPct_(num, den) { return den ? ((num >= 0 ? '+' : '') + (num / den * 100).toFixed(1) + '%') : '—'; }

/** 共同支出統計：本月合計、預算、誰欠誰、公基金（算法同前端 balance.ts） */
function hhLedgerStats_(hh, hid) {
  var now = new Date();
  var monthKey = Utilities.formatDate(now, TZ, 'yyyy-MM');
  var mStart = new Date(monthKey + '-01T00:00:00+08:00');
  var weekStart = new Date(now.getTime() - 7 * 86400000);
  var since = new Date(now.getTime() - 730 * 86400000);
  var net = {};
  var paidThisMonth = {};
  (hh.memberIds || []).forEach(function (id) { net[id] = 0; paidThisMonth[id] = 0; });
  var monthTotal = 0;
  var weekTotal = 0;
  var fundSpent = 0;
  /** 公基金負擔、由成員先墊的金額（同前端 summarizeHouseholdFund 的 advancedByMember） */
  var fundAdvanced = {};
  var txs = fsRunQuery_('', {
    from: [{ collectionId: 'transactions' }],
    where: {
      compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: 'householdId' }, op: 'EQUAL', value: { stringValue: hid } } },
        { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: since.toISOString() } } },
      ] },
    },
    limit: 3000,
  });
  var memberIds = hh.memberIds || [];
  txs.forEach(function (t) {
    if (t.deletedAt || t.type !== 'expense') return;
    var full = Number(t.settledAmountTWD != null ? t.settledAmountTWD : t.amountTWD) || 0;
    var d = t.date ? new Date(t.date) : null;
    if (isHouseholdFundPaid_(t)) {
      if (d && d >= mStart) monthTotal += full;
      if (d && d >= weekStart) weekTotal += full;
      fundSpent += full;
      if (t.fundAdvancedBy) fundAdvanced[t.fundAdvancedBy] = (fundAdvanced[t.fundAdvancedBy] || 0) + full;
      return;
    }
    // 與前端 balance.ts 同一條規則：
    //  - 只算共同帳本成員的份（同時歸入旅程的交易，外面旅伴那份走旅程結算）
    //  - 付款人不是成員（外面旅伴付的）→ 共同帳本內沒有欠款
    //  - 墊付只算成員那幾份的加總，不是整筆
    var shares = hhSharesOfTx_(t, memberIds, full);
    var portion = t.tripId ? Object.keys(shares).reduce(function (s, k) { return s + shares[k]; }, 0) : full;
    if (d && d >= mStart) monthTotal += portion;
    if (d && d >= weekStart) weekTotal += portion;
    var payer = t.paidByUid || t.payerId || t.userId;
    if (memberIds.indexOf(payer) < 0) return;
    if (d && d >= mStart) paidThisMonth[payer] = (paidThisMonth[payer] || 0) + portion;
    net[payer] = (net[payer] || 0) + portion;
    Object.keys(shares).forEach(function (id) { net[id] = (net[id] || 0) - shares[id]; });
  });
  fsListAllDocs_('households/' + hid + '/settlements', 300).forEach(function (s) {
    net[s.fromUid] = (net[s.fromUid] || 0) + (Number(s.amountTWD) || 0);
    net[s.toUid] = (net[s.toUid] || 0) - (Number(s.amountTWD) || 0);
  });
  var fundIn = 0;
  // 撥還（reimbursement）只是把錢轉給先墊的人，不是存入，也不影響帳上可用餘額
  var fundReimbursed = {};
  fsListAllDocs_('households/' + hid + '/fund_entries', 1000).forEach(function (f) {
    if (f.type === 'reimbursement') {
      if (f.contributorUid) fundReimbursed[f.contributorUid] = (fundReimbursed[f.contributorUid] || 0) + (Number(f.amountTWD) || 0);
      return;
    }
    fundIn += Number(f.amountTWD) || 0;
  });
  return {
    monthTotal: monthTotal,
    weekTotal: weekTotal,
    paidThisMonth: paidThisMonth,
    net: net,
    fundBalance: fundIn - fundSpent,
    // 公基金還欠先墊成員多少（正數才列）
    fundOwed: memberIds.map(function (id) {
      return { uid: id, amount: Math.round((fundAdvanced[id] || 0) - (fundReimbursed[id] || 0)) };
    }).filter(function (row) { return row.amount > 0; }),
    hasFund: fundIn > 0 || fundSpent > 0,
    budget: typeof hh.monthlyBudgetTWD === 'number' ? hh.monthlyBudgetTWD : 0,
  };
}

function hhMemberName_(hh, uid) {
  return (hh.members && hh.members[uid] && hh.members[uid].displayName) || '成員';
}

/** 組報告文字（純文字、無 emoji；CLAUDE.md §15） */
/**
 * 共同帳本成員各自應負擔的金額（與前端 household/balance.ts `sharesOfTx` 一致）。
 * customShares 為主、只保留 memberIds 裡的人；沒有 customShares 就當付款人全付。
 */
function hhSharesOfTx_(t, memberIds, totalTWD) {
  var out = {};
  memberIds.forEach(function (id) { out[id] = 0; });
  var cs = Array.isArray(t.customShares) ? t.customShares : [];
  if (cs.length) {
    var csTotal = cs.reduce(function (s, c) { return s + (Number(c.amountTWD) || 0); }, 0);
    var ratio = csTotal > 0 ? totalTWD / csTotal : 1;
    cs.forEach(function (c) {
      if (memberIds.indexOf(c.memberId) < 0) return;
      out[c.memberId] = (out[c.memberId] || 0) + (Number(c.amountTWD) || 0) * ratio;
    });
    return out;
  }
  var payer = t.paidByUid || t.payerId || t.userId;
  if (memberIds.indexOf(payer) >= 0) out[payer] = totalTWD;
  return out;
}

function buildHouseholdReport_(hid, opts) {
  opts = opts || {};
  var hh = fsGetDoc_('households/' + hid);
  if (!hh) return '找不到共同帳本。';
  var lines = [];
  lines.push('[' + (hh.name || '共同帳本') + '] ' + (opts.title || '共同帳本報告'));
  lines.push(Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm'));

  if (opts.includeLedger !== false) {
    lines.push('');
    lines.push('— 共同支出 —');
    try {
      var s = hhLedgerStats_(hh, hid);
      var monthLine = '本月 NT$' + n0(s.monthTotal);
      if (s.budget > 0) monthLine += ' / 預算 NT$' + n0(s.budget) + '（' + Math.round(s.monthTotal / s.budget * 100) + '%）';
      lines.push(monthLine);
      lines.push('近 7 天 NT$' + n0(s.weekTotal));
      (hh.memberIds || []).forEach(function (id) {
        lines.push('  ' + hhMemberName_(hh, id) + ' 本月墊付 NT$' + n0(s.paidThisMonth[id] || 0));
      });
      var debtors = (hh.memberIds || []).filter(function (id) { return (s.net[id] || 0) < -0.5; });
      var creditors = (hh.memberIds || []).filter(function (id) { return (s.net[id] || 0) > 0.5; });
      if (debtors.length && creditors.length) {
        lines.push('待結算：' + hhMemberName_(hh, debtors[0]) + ' 還要付 ' + hhMemberName_(hh, creditors[0])
          + ' NT$' + n0(Math.min(-s.net[debtors[0]], s.net[creditors[0]])));
      } else {
        lines.push('待結算：兩不相欠');
      }
      if (s.hasFund) lines.push('公基金餘額 NT$' + n0(s.fundBalance));
      if (s.fundOwed && s.fundOwed.length) {
        var keeper = hh.fundKeeperUid ? hhMemberName_(hh, hh.fundKeeperUid) : '';
        s.fundOwed.forEach(function (row) {
          lines.push('公基金待撥還：' + (keeper ? keeper + ' 從公基金' : '公基金') + '轉 NT$' + n0(row.amount) + ' 給 ' + hhMemberName_(hh, row.uid));
        });
      }
    } catch (err) {
      console.warn('buildHouseholdReport_ ledger', err);
      lines.push('（共同支出讀取失敗）');
    }
  }

  if (opts.includeInvestments !== false) {
    lines.push('');
    lines.push('— 共同投資 —');
    try {
      var holdings = hhListHoldings_(hid);
      if (!holdings.length) {
        lines.push('還沒有持股，到 RMoney「共同 → 投資」新增。');
      } else {
        var v = hhValueHoldings_(hh, holdings);
        lines.push('總市值 NT$' + n0(v.totalValueTWD) + '（成本 NT$' + n0(v.totalCostTWD) + '）');
        lines.push('未實現損益 ' + hhSign_(v.unrealizedTWD) + '（' + hhPct_(v.unrealizedTWD, v.totalCostTWD) + '）');
        if (Math.abs(v.realizedTWD) >= 1) lines.push('已實現損益 ' + hhSign_(v.realizedTWD));
        if (Math.abs(v.dayChangeTWD) >= 1) lines.push('今日變動 ' + hhSign_(v.dayChangeTWD));
        var jointB = v.byBucket.joint;
        if (jointB) lines.push('  共同持有 NT$' + n0(jointB.valueTWD) + '，' + hhSign_(jointB.unrealizedTWD));
        (hh.memberIds || []).forEach(function (id) {
          var b = v.byBucket[id];
          if (b) lines.push('  ' + hhMemberName_(hh, id) + ' 個人 NT$' + n0(b.valueTWD) + '，' + hhSign_(b.unrealizedTWD));
        });
        lines.push('各自持有（含共同持有的份額）：');
        (hh.memberIds || []).forEach(function (id) {
          var m = v.byMember[id];
          if (m) lines.push('  ' + hhMemberName_(hh, id) + ' NT$' + n0(m.valueTWD) + '（' + hhPct_(m.unrealizedTWD, m.costTWD) + '）');
        });
        if (v.positions.length) {
          lines.push('前 5 大持股：');
          v.positions.slice(0, 5).forEach(function (p) {
            lines.push('  ' + p.symbol + ' ' + p.name + ' NT$' + n0(p.valueTWD) + '（' + (p.pnlPct >= 0 ? '+' : '') + p.pnlPct.toFixed(1) + '%）');
          });
        }
        var plan = hh.investmentPlan;
        if (plan && Number(plan.targetAmountTWD) > 0) {
          var pct = Math.min(999, v.totalValueTWD / Number(plan.targetAmountTWD) * 100);
          var planLine = '目標「' + (plan.name || '共同投資目標') + '」NT$' + n0(plan.targetAmountTWD) + '，已達 ' + pct.toFixed(1) + '%';
          if (plan.targetDate) planLine += '（目標日 ' + Utilities.formatDate(new Date(plan.targetDate), TZ, 'yyyy/MM') + '）';
          lines.push(planLine);
        }
        if (v.missingPrices.length) lines.push('（' + v.missingPrices.slice(0, 5).join('、') + ' 暫無報價，以成本計）');
      }
    } catch (err) {
      console.warn('buildHouseholdReport_ invest', err);
      lines.push('（共同投資讀取失敗）');
    }
  }

  var appUrl = PROP.getProperty('APP_URL');
  if (appUrl) {
    lines.push('');
    lines.push(String(appUrl).replace(/\/$/, '') + '/shared');
  }
  return lines.join('\n');
}

/** household 成員的 chatId 清單：有綁定用綁定的；owner 沒綁定退回 TG_CHAT_ID */
function hhRecipientChats_(hh) {
  var chats = [];
  (hh.memberIds || []).forEach(function (uid) {
    var link = null;
    try { link = fsGetDoc_('telegram_links/' + uid); } catch (ignoredErr) { console.warn('[HouseholdTelegram:383] ignored', ignoredErr); }
    var chatId = link && link.chatId ? String(link.chatId) : (uid === hh.ownerId ? PROP.getProperty('TG_CHAT_ID') : null);
    if (chatId && chats.indexOf(chatId) < 0) chats.push(chatId);
  });
  return chats;
}

function hhReportDue_(frequency, now) {
  var dow = Utilities.formatDate(now, TZ, 'u'); // 1 = Mon … 7 = Sun
  var dom = Utilities.formatDate(now, TZ, 'd');
  if (frequency === 'daily') return true;
  if (frequency === 'monthly') return dom === '1';
  return dow === '7'; // weekly（預設）
}

/** 21:00 排程：依各 household 的設定發報告 */
function runHouseholdReports(force) {
  var now = new Date();
  var sent = [];
  var households = [];
  try { households = fsListDocs_('households', 50); } catch (err) {
    console.warn('runHouseholdReports list', err);
    return { ok: false, error: String(err && err.message || err) };
  }
  households.forEach(function (hh) {
    var cfg = hh.householdReport;
    if (!cfg || cfg.enabled !== true) return;
    if (!force && !hhReportDue_(cfg.frequency || 'weekly', now)) return;
    var hid = String(hh._name).split('/').pop();
    var title = cfg.frequency === 'daily' ? '共同帳本日報' : cfg.frequency === 'monthly' ? '共同帳本月報' : '共同帳本週報';
    var text = buildHouseholdReport_(hid, {
      includeLedger: cfg.includeLedger !== false,
      includeInvestments: cfg.includeInvestments !== false,
      title: title,
    });
    hhRecipientChats_(hh).forEach(function (chatId) {
      var r = sendTelegramToChat_(chatId, text);
      if (!r.ok) console.warn('runHouseholdReports send failed', hid, r.error);
    });
    sent.push(hid);
  });
  return { ok: true, sent: sent };
}

/** 前端「立即傳一份給我」：只傳給呼叫者自己綁定的 chat（owner 沒綁定 → TG_CHAT_ID） */
function sendHouseholdReportNow(body, authResult) {
  var hid = String((body && body.householdId) || '');
  var hh = hhRequireMember_(hid, authResult);
  var link = fsGetDoc_('telegram_links/' + authResult.uid);
  var chatId = link && link.chatId ? link.chatId : (authResult.uid === hh.ownerId ? PROP.getProperty('TG_CHAT_ID') : null);
  if (!chatId) return { ok: false, error: '你還沒連結 Telegram，先按「連結 Telegram」' };
  var cfg = hh.householdReport || {};
  var text = buildHouseholdReport_(hid, {
    includeLedger: cfg.includeLedger !== false,
    includeInvestments: cfg.includeInvestments !== false,
    title: '共同帳本報告（手動）',
  });
  var r = sendTelegramToChat_(chatId, text);
  if (!r.ok) return { ok: false, error: r.error || '傳送失敗' };
  return { ok: true };
}
