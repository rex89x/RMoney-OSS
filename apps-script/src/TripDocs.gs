/**
 * Trip Documents — Drive 同步 + 邀請流程
 *
 * 1. syncTripDocumentToDrive — 把前端上傳的檔案 / 連結同步到 Drive
 *    Drive 結構：BACKUP_FOLDER_ID / Trips / {YYYY} - {trip name} / *
 *    每個 trip 一個資料夾，名稱以 trip.name 為準（重命名後仍認 trips 子資料夾名）。
 *
 * 2. inviteTripUser — 把 email 加進 config.allowedEmails 白名單，並寫入 trip.pendingInvites
 *    安全：caller 必須是該 trip owner（透過 idToken 比對）。
 *
 * 3. acceptPendingInvites — user 首次登入呼叫，把自己 uid 加到所有 pending 的 trip.sharedWith
 */

function _tripsRootFolder_() {
  var raw = PROP.getProperty('BACKUP_FOLDER_ID');
  if (!raw) throw new Error('BACKUP_FOLDER_ID not set; run setupBackupFolder() once');
  var rootId = extractFolderId_(raw);
  var root = DriveApp.getFolderById(rootId);
  var existing = root.getFoldersByName('Trips');
  if (existing.hasNext()) return existing.next();
  return root.createFolder('Trips');
}

function _sanitizeName_(s) {
  return String(s || '')
    .replace(/[\\/\:\*\?"<>\|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'untitled';
}

function _tripFolder_(trip, tripId) {
  var trips = _tripsRootFolder_();
  var year = '';
  if (trip && trip.startDate) {
    var d = trip.startDate.seconds ? new Date(trip.startDate.seconds * 1000) : new Date(trip.startDate);
    if (!isNaN(d.getTime())) year = String(d.getFullYear());
  }
  var label = _sanitizeName_((year ? year + ' - ' : '') + ((trip && trip.name) || tripId));
  var existing = trips.getFoldersByName(label);
  if (existing.hasNext()) return existing.next();
  return trips.createFolder(label);
}

/**
 * Body: {
 *   tripId,
 *   docId,
 *   title,
 *   url?,             // link 模式
 *   fileBase64?,      // file 模式（base64-encoded raw bytes）
 *   fileName?,
 *   contentType?
 * }
 */
function syncTripDocumentToDrive(body) {
  if (!body || !body.tripId || !body.docId) {
    return { ok: false, error: 'missing tripId or docId' };
  }
  var trip;
  try { trip = fsGetDoc_('trips/' + body.tripId); }
  catch (err) { return { ok: false, error: 'trip-not-found: ' + (err && err.message || err) }; }
  if (!trip) return { ok: false, error: 'trip-not-found' };

  var folder;
  try { folder = _tripFolder_(trip, body.tripId); }
  catch (err) { return { ok: false, error: 'folder: ' + (err && err.message || err) }; }

  if (body.fileBase64 && body.fileName) {
    try {
      var bytes = Utilities.base64Decode(body.fileBase64);
      var blob = Utilities.newBlob(bytes, body.contentType || 'application/octet-stream', _sanitizeName_(body.fileName));
      var file = folder.createFile(blob);
      // 寫回 Firestore
      fsSetDoc_('trips/' + body.tripId + '/documents/' + body.docId, {
        driveFileId: file.getId(),
        driveLink: file.getUrl(),
        updatedAt: new Date(),
      }, true);
      return { ok: true, driveFileId: file.getId(), driveLink: file.getUrl(), folderUrl: folder.getUrl() };
    } catch (err) {
      return { ok: false, error: 'upload-failed: ' + (err && err.message || err) };
    }
  }

  // link 模式：寫一個 .url 檔放進資料夾（macOS / Windows 都能開）
  if (body.url) {
    var name = _sanitizeName_(body.title || 'link') + '.url';
    var content = '[InternetShortcut]\nURL=' + body.url + '\n';
    var f = folder.createFile(Utilities.newBlob(content, 'text/plain', name));
    fsSetDoc_('trips/' + body.tripId + '/documents/' + body.docId, {
      driveFileId: f.getId(),
      driveLink: f.getUrl(),
      updatedAt: new Date(),
    }, true);
    return { ok: true, driveFileId: f.getId(), driveLink: f.getUrl(), folderUrl: folder.getUrl() };
  }

  return { ok: false, error: 'no-payload' };
}

/**
 * Body: { tripId, email }
 * 安全：authenticate_ 已驗 idToken；只允許該 trip 的 owner 邀請
 */
function inviteTripUser(body, authResult) {
  if (!body || !body.tripId || !body.email) {
    return { ok: false, error: 'missing tripId or email' };
  }
  var email = String(body.email).trim().toLowerCase();
  if (!email || email.indexOf('@') < 0) return { ok: false, error: 'invalid email' };

  var trip;
  try { trip = fsGetDoc_('trips/' + body.tripId); }
  catch (err) { return { ok: false, error: 'trip-not-found: ' + (err && err.message || err) }; }
  if (!trip) return { ok: false, error: 'trip-not-found' };

  var callerEmail = String((authResult && authResult.email) || '').toLowerCase();
  var ownerEmail = String(trip.ownerEmail || '').toLowerCase();
  // 沒存 ownerEmail 就允許（owner 是 owner uid）— 但比對 owner uid
  if (callerEmail && ownerEmail && callerEmail !== ownerEmail) {
    return { ok: false, error: 'not-owner' };
  }

  // 1. 把 email 加進 config/guestEmails（trip 限定，不給整 app 權限）
  try {
    var cfg = fsGetDoc_('config/guestEmails') || {};
    var emails = Array.isArray(cfg.emails) ? cfg.emails.slice() : [];
    var lower = emails.map(function (e) { return String(e).toLowerCase(); });
    if (lower.indexOf(email) < 0) emails.push(email);
    fsSetDoc_('config/guestEmails', { emails: emails }, true);
    writeWhitelistHashes_('guestEmails', emails);
  } catch (err) {
    return { ok: false, error: 'guest-list-update-failed: ' + (err && err.message || err) };
  }

  // 2. 加進 trip.pendingInvites
  try {
    var pending = Array.isArray(trip.pendingInvites) ? trip.pendingInvites.slice() : [];
    var lp = pending.map(function (e) { return String(e).toLowerCase(); });
    if (lp.indexOf(email) < 0) pending.push(email);
    fsSetDoc_('trips/' + body.tripId, { pendingInvites: pending }, true);
  } catch (err) {
    return { ok: false, error: 'pending-update-failed: ' + (err && err.message || err) };
  }

  return { ok: true, email: email };
}

/**
 * 邀請伴侶加入共同帳本（households/{id}）。
 * - caller 必須是 household.ownerId
 * - email 加進 config/allowedEmails（首次登入會拿到 role 'member'：只看得到 /shared、分享的 trips、設定）
 * - 寫進 household.pendingInvites；對方首次登入後 acceptPendingInvites 把 uid 加進 memberIds
 */
function inviteHouseholdMember(body, authResult) {
  if (!body || !body.householdId || !body.email) {
    return { ok: false, error: 'missing householdId or email' };
  }
  var email = String(body.email).trim().toLowerCase();
  if (!email || email.indexOf('@') < 0) return { ok: false, error: 'invalid email' };
  var uid = String((authResult && authResult.uid) || '');

  var hh;
  try { hh = fsGetDoc_('households/' + body.householdId); }
  catch (err) { return { ok: false, error: 'household-not-found: ' + (err && err.message || err) }; }
  if (!hh) return { ok: false, error: 'household-not-found' };
  if (hh.ownerId !== uid) return { ok: false, error: 'not-owner' };

  try { ensureAllowedEmail_(email); }
  catch (err) { return { ok: false, error: 'allowed-list-update-failed: ' + (err && err.message || err) }; }

  try {
    var pending = Array.isArray(hh.pendingInvites) ? hh.pendingInvites.slice() : [];
    var lp = pending.map(function (e) { return String(e).toLowerCase(); });
    if (lp.indexOf(email) < 0) pending.push(email);
    fsSetDoc_('households/' + body.householdId, { pendingInvites: pending, updatedAt: new Date() }, true);
  } catch (err) {
    return { ok: false, error: 'pending-update-failed: ' + (err && err.message || err) };
  }
  return { ok: true, email: email };
}

/** 把 uid 加進 household（memberIds / members / splitRatio / pendingInvites）；已是成員就只清 pending */
function addHouseholdMember_(h, hid, uid, email, displayName) {
  var colors = ['#3b82f6', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4'];
  var memberIds = Array.isArray(h.memberIds) ? h.memberIds.slice() : [];
  var isNew = memberIds.indexOf(uid) < 0;
  if (isNew) memberIds.push(uid);
  var members = (h.members && typeof h.members === 'object') ? JSON.parse(JSON.stringify(h.members)) : {};
  if (!members[uid]) {
    members[uid] = { uid: uid, displayName: displayName || email, email: email, color: colors[(memberIds.length - 1) % colors.length] };
  }
  var pending = (h.pendingInvites || []).filter(function (e) { return String(e).toLowerCase() !== email; });
  var ratio = (h.splitRatio && typeof h.splitRatio === 'object') ? JSON.parse(JSON.stringify(h.splitRatio)) : {};
  var ratioKeys = Object.keys(ratio).filter(function (k) { return memberIds.indexOf(k) >= 0 && ratio[k] > 0; });
  if (ratioKeys.length < 2) {
    var each = Math.floor(100 / memberIds.length);
    memberIds.forEach(function (id, i) { ratio[id] = i === 0 ? 100 - each * (memberIds.length - 1) : each; });
  }
  fsSetDoc_('households/' + hid, {
    memberIds: memberIds,
    members: members,
    pendingInvites: pending,
    splitRatio: ratio,
    updatedAt: new Date(),
  }, true);
  return isNew;
}

/** 確保 email 在 config/allowedEmails（不分大小寫）；同步雜湊 doc 給前端登入檢查 */
function ensureAllowedEmail_(email) {
  var cfg = fsGetDoc_('config/allowedEmails') || {};
  var emails = Array.isArray(cfg.emails) ? cfg.emails.slice() : [];
  var lower = emails.map(function (e) { return String(e).toLowerCase(); });
  if (lower.indexOf(email) < 0) {
    emails.push(email);
    fsSetDoc_('config/allowedEmails', { emails: emails }, true);
    writeWhitelistHashes_('allowedEmails', emails);
    return true;
  }
  return false;
}

/**
 * 白名單雜湊（與前端 lib/email-hash.ts 完全一致：trim + 小寫 + SHA-256 hex）。
 * 前端登入前只讀 config/*Hashes，所以任何一處改明文名單都要呼叫 writeWhitelistHashes_。
 */
var WHITELIST_HASH_DOCS_ = { allowedEmails: 'allowedEmailHashes', guestEmails: 'guestEmailHashes' };

function emailHash_(email) {
  var normalized = String(email || '').trim().toLowerCase();
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, normalized, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    var h = (b < 0 ? b + 256 : b).toString(16);
    return h.length === 1 ? '0' + h : h;
  }).join('');
}

function writeWhitelistHashes_(docId, emails) {
  var seen = {};
  var hashes = [];
  (emails || []).forEach(function (e) {
    var n = String(e || '').trim().toLowerCase();
    if (!n || seen[n]) return;
    seen[n] = true;
    hashes.push(emailHash_(n));
  });
  hashes.sort();
  fsSetDoc_('config/' + WHITELIST_HASH_DOCS_[docId], {
    hashes: hashes,
    count: hashes.length,
    syncedAt: new Date(),
    syncedBy: 'apps-script',
  }, true);
  return hashes.length;
}

/** checkAccess 用：10 分鐘內只重算一次，避免每次登入都多兩次寫入 */
function syncWhitelistHashesThrottled_() {
  var cache = CacheService.getScriptCache();
  var key = 'whitelistHashesSynced:v1';
  if (cache.get(key)) return { skipped: true };
  var out = syncWhitelistHashes_();
  cache.put(key, '1', 600);
  return out;
}

/** 重算兩份雜湊 doc（每日 01:00 排程 + setup 用；admin 在前端改名單時也會同步，這裡是保險） */
function syncWhitelistHashes_() {
  var out = {};
  ['allowedEmails', 'guestEmails'].forEach(function (docId) {
    var cfg = fsGetDoc_('config/' + docId) || {};
    out[docId] = writeWhitelistHashes_(docId, Array.isArray(cfg.emails) ? cfg.emails : []);
  });
  return out;
}

/**
 * 用邀請碼加入共同帳本（/login?join=CODE）。
 * - 不需要先在白名單：驗證 token 後比對 households.inviteCode，成功就把 email 加進白名單 + household。
 * - 一個 code 對應一個 household；只有 owner 能產生 / 重設（rules）。
 * - 24 小時有效（inviteCodeExpiresAt）、加入成功即清除（單次使用）。
 */
function joinHousehold(body, authResult) {
  var code = String((body && body.code) || '').trim().toUpperCase();
  if (!code || code.length < 6) return { ok: false, error: 'invalid-code' };
  var email = String(authResult.email || '').toLowerCase();
  var uid = String(authResult.uid || '');
  if (!email || !uid) return { ok: false, error: 'missing identity' };

  var docs = [];
  try {
    docs = fsRunQuery_('', {
      from: [{ collectionId: 'households' }],
      where: { fieldFilter: { field: { fieldPath: 'inviteCode' }, op: 'EQUAL', value: { stringValue: code } } },
      limit: 1,
    });
  } catch (err) {
    return { ok: false, error: 'lookup-failed: ' + (err && err.message || err) };
  }
  var h = docs[0];
  if (!h) return { ok: false, error: 'code-not-found' };
  var hid = String(h._name).split('/').pop();
  // 24 小時有效 + 單次使用：沒有到期時間（舊碼）或已過期一律拒絕，owner 要在設定重設
  var expiresAt = h.inviteCodeExpiresAt instanceof Date ? h.inviteCodeExpiresAt
    : (h.inviteCodeExpiresAt ? new Date(h.inviteCodeExpiresAt) : null);
  if (!expiresAt || isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: 'code-expired' };
  }

  var displayName = authResult.displayName || '';
  try {
    var existingUser = fsGetDoc_('users/' + uid);
    if (existingUser && (existingUser.displayName || existingUser.email)) displayName = existingUser.displayName || existingUser.email;
  } catch (_) {}

  var addedToWhitelist = false;
  try { addedToWhitelist = ensureAllowedEmail_(email); }
  catch (err) { return { ok: false, error: 'whitelist-update-failed: ' + (err && err.message || err) }; }

  // 若之前只在 viewer 名單，升成 member（users doc 若已存在且是 viewer → 改 member）
  try {
    var u = fsGetDoc_('users/' + uid);
    if (u && (u.role === 'viewer' || u.role === 'guest')) fsSetDoc_('users/' + uid, { role: 'member' }, true);
  } catch (_) {}

  var isNew = false;
  try { isNew = addHouseholdMember_(h, hid, uid, email, displayName); }
  catch (err) { return { ok: false, error: 'join-failed: ' + (err && err.message || err) }; }

  // 單次使用：加入成功就把碼清掉，同一條連結不能再被第二個人用
  try { fsSetDoc_('households/' + hid, { inviteCode: null, inviteCodeExpiresAt: null, updatedAt: new Date() }, true); }
  catch (err) { console.warn('joinHousehold clear code failed', err); }

  return { ok: true, householdId: hid, name: h.name || '', joined: isNew, addedToWhitelist: addedToWhitelist };
}

/**
 * 接受共同帳本邀請：把 uid 加進 memberIds / members，pendingInvites 移除，
 * 並在第一次補齊 splitRatio（沒設或只有 owner → 均分）。
 */
function acceptHouseholdInvites_(email, uid) {
  var applied = [];
  var docs = [];
  try {
    docs = fsRunQuery_('', {
      from: [{ collectionId: 'households' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'pendingInvites' },
          op: 'ARRAY_CONTAINS',
          value: { stringValue: email },
        },
      },
      limit: 20,
    });
  } catch (err) {
    console.warn('acceptHouseholdInvites_ query', err);
    return applied;
  }
  if (!docs.length) return applied;

  var userDoc = null;
  try { userDoc = fsGetDoc_('users/' + uid) || null; } catch (err) { console.warn('acceptHouseholdInvites_ user', err); }
  var displayName = (userDoc && (userDoc.displayName || userDoc.email)) || email;

  docs.forEach(function (h) {
    var hid = (h._name || '').split('/').pop();
    if (!hid) return;
    try {
      addHouseholdMember_(h, hid, uid, email, displayName);
      applied.push(hid);
    } catch (err) {
      console.warn('acceptHouseholdInvites_ set', hid, err);
    }
  });
  return applied;
}

/**
 * 由前端登入後呼叫：把自己加到所有 pending invites 的 trip.sharedWith 與 household.memberIds。
 * 回傳套用了哪些 trip / household。
 */
function acceptPendingInvites(_body, authResult) {
  var email = String((authResult && authResult.email) || '').toLowerCase();
  var uid = String((authResult && authResult.uid) || '');
  var isViewer = !!(authResult && authResult.isViewer);
  if (!email || !uid) return { ok: false, error: 'missing identity' };

  // 1. 用 runQuery 找 pendingInvites 含 email 的 trips
  var docs = [];
  try {
    docs = fsRunQuery_('', {
      from: [{ collectionId: 'trips' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'pendingInvites' },
          op: 'ARRAY_CONTAINS',
          value: { stringValue: email },
        },
      },
      limit: 100,
    });
  } catch (err) {
    console.warn('acceptPendingInvites query', err);
  }

  var applied = [];
  docs.forEach(function (t) {
    var tripId = (t._name || '').split('/').pop();
    if (!tripId) return;
    var sharedWith = Array.isArray(t.sharedWith) ? t.sharedWith.slice() : [];
    if (sharedWith.indexOf(uid) < 0) sharedWith.push(uid);
    var pending = (t.pendingInvites || []).filter(function (e) {
      return String(e).toLowerCase() !== email;
    });
    try {
      fsSetDoc_('trips/' + tripId, {
        sharedWith: sharedWith,
        pendingInvites: pending,
      }, true);
      applied.push(tripId);
    } catch (err) {
      console.warn('acceptPendingInvites set', tripId, err);
    }
  });

  // 2. 若使用者只在 viewer 名單（config/guestEmails），把 users/{uid}.role 強制設成 'viewer'
  //    （Rules 不允許使用者自改 role；改由這裡 admin SDK 寫入）
  if (isViewer) {
    try {
      var existing = fsGetDoc_('users/' + uid) || {};
      // 'guest' 是舊稱，也視同 viewer 不再覆蓋；其他角色一律降為 viewer
      if (existing.role !== 'viewer' && existing.role !== 'guest') {
        fsSetDoc_('users/' + uid, { role: 'viewer' }, true);
      }
    } catch (err) {
      console.warn('acceptPendingInvites demote-to-viewer', err);
    }
  }

  // 3. 共同帳本邀請（viewer 不會被邀進 household；allowedEmails 才會）
  var households = [];
  if (!isViewer) {
    try { households = acceptHouseholdInvites_(email, uid); }
    catch (err) { console.warn('acceptPendingInvites households', err); }
  }

  return { ok: true, applied: applied, households: households, demotedToViewer: isViewer };
}
