/**
 * Daily backup — 把主要 Firestore collections export 成 JSON 寫入 Drive
 *
 * Drive 設置：
 *   PROP.BACKUP_FOLDER_ID = Google Drive folder id（先建立 owner 的資料夾並 grant edit 給 Apps Script）
 *
 * 排程：tick_daily_0100 每日 01:00（SPEC §11.9：每日、保留 30 天；2026-11 之前是每週日 03:00 / 56 天）
 * Telegram：通知開關 weeklyBackup（key 沿用，設定頁不用遷移）
 * 完整性：fsListAllDocs_ 自動翻頁，任何 collection 讀取失敗會另外 notifyError（以前 1000 筆硬截且靜默）
 */

var BACKUP_RETENTION_DAYS_ = 30;

function dailyBackupRun() {
  return weeklyBackupRun();
}

function weeklyBackupRun() {
  var raw = PROP.getProperty('BACKUP_FOLDER_ID');
  if (!raw) {
    var msg = '[Personal Hub] 備份失敗 — Script Property BACKUP_FOLDER_ID 未設定。\n'
      + '在 Apps Script 編輯器跑 setupBackupFolder() 可自動建立並寫入。';
    sendNotification_('weeklyBackup', msg);
    return { ok: false, error: 'BACKUP_FOLDER_ID-not-set' };
  }
  // 容忍貼整段 Drive URL：抽出實際 folder id
  var folderId = extractFolderId_(raw);
  var folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (err) {
    var detail = String(err && err.message || err);
    var diagMsg = [
      '[Personal Hub] 備份失敗 — Drive folder 找不到',
      '輸入: ' + raw,
      '解析後 ID: ' + folderId,
      '錯誤: ' + detail,
      '',
      '排查：',
      '1. 確認 ID 是「資料夾」的 (網址 /folders/<ID>)，不是檔案 ID',
      '2. 資料夾必須在 Apps Script 執行帳號 (' + Session.getEffectiveUser().getEmail() + ') 的「我的雲端硬碟」內',
      '3. 共用雲端硬碟 (Shared Drive) 也可，但需先把該帳號加為成員',
      '4. 或在 Apps Script 編輯器跑 setupBackupFolder() 自動建立',
    ].join('\n');
    sendNotification_('weeklyBackup', diagMsg);
    return { ok: false, error: 'folder-not-found', detail: detail, parsedId: folderId };
  }

  // 要備份的 collections
  var cols = [
    'transactions', 'categories', 'budgets', 'recurring',
    'accounts', 'payment_methods', 'credit_card_bills',
    'cash_accounts', 'manual_assets', 'liabilities', 'net_worth_snapshots',
    'subscriptions', 'scheduled_payments', 'savings_goals',
    'portfolio', 'portfolio_snapshots', 'stocks', 'fx_rates',
    'realized_lots', 'dividends', 'watchlist', 'alerts', 'trips', 'flight_watches',
    'ai_budget_configs', 'ai_usage_events',
    // 台指期虛擬帳戶含手動單，無法事後由日 K 重算，一起備份（日 K / 訊號可從期交所重抓，不備份）
    'taifex_configs', 'taifex_paper_accounts', 'taifex_paper_trades', 'taifex_reviews', 'taifex_tuning',
    // 2026-11 補上：之前漏備份的頂層 collection（子集合如 households/*/settlements 仍未涵蓋）
    'rentals', 'households', 'payout_groups', 'investment_plans', 'itineraries', 'audit_logs',
    'installment_plans',
  ];
  var dateStr = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var summary = { generatedAt: new Date().toISOString(), counts: {} };
  var bundle = {};
  var totalDocs = 0;

  var failedCols = [];
  cols.forEach(function (col) {
    try {
      var docs = fsListAllDocs_(col, 300);
      bundle[col] = docs.map(function (d) {
        // 移除 _name 雜訊
        var clean = {};
        Object.keys(d).forEach(function (k) { if (k !== '_name') clean[k] = d[k]; });
        clean._id = d._name ? d._name.split('/').pop() : null;
        return clean;
      });
      summary.counts[col] = docs.length;
      totalDocs += docs.length;
    } catch (err) {
      summary.counts[col] = 'error: ' + (err && err.message || err);
      failedCols.push(col);
      console.warn('backup col failed', col, err);
    }
  });
  if (failedCols.length) {
    try { notifyError('backup', new Error('collections 讀取失敗，本次備份不完整: ' + failedCols.join(', '))); } catch (nErr) { console.warn('backup notifyError', nErr); }
  }

  // 寫入 Drive — 一個檔案 (壓縮：使用 Utilities.newBlob + setName)
  var fileName = 'personal-hub-backup-' + dateStr + '.json';
  var blob = Utilities.newBlob(JSON.stringify({ summary: summary, data: bundle }, null, 0), 'application/json', fileName);
  var file = folder.createFile(blob);

  // 清掉超過保留天數的舊備份（名稱前綴比對）
  var cutoff = Date.now() - BACKUP_RETENTION_DAYS_ * 24 * 3600 * 1000;
  var purged = 0;
  var allFiles = folder.getFiles();
  while (allFiles.hasNext()) {
    var f = allFiles.next();
    if (f.getName().indexOf('personal-hub-backup-') !== 0) continue;
    if (f.getDateCreated().getTime() < cutoff) {
      f.setTrashed(true);
      purged++;
    }
  }

  var lines = [
    '[Personal Hub] 每日備份完成',
    '--------------------',
    '檔案：' + fileName,
    '文件總數：' + totalDocs,
    'collections：' + Object.keys(summary.counts).length,
    purged > 0 ? '清掉舊檔：' + purged : null,
    failedCols.length ? '讀取失敗：' + failedCols.join(', ') : null,
  ].filter(Boolean);
  sendNotification_('weeklyBackup', lines.join('\n'));

  return { ok: failedCols.length === 0, file: file.getId(), totalDocs: totalDocs, failedCollections: failedCols };
}

/**
 * 從 raw 輸入抽出 Drive folder id：
 *   https://drive.google.com/drive/folders/<ID>?usp=...
 *   https://drive.google.com/drive/u/0/folders/<ID>
 *   https://drive.google.com/open?id=<ID>
 *   <ID>
 */
function extractFolderId_(input) {
  if (!input) return input;
  var s = String(input).trim();
  var m = s.match(/\/folders\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  var m2 = s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (m2) return m2[1];
  return s;
}

/**
 * 一次性 helper：在執行帳號的「我的雲端硬碟」根目錄建立 Personal Hub Backups 資料夾，
 * 並把 ID 自動寫入 Script Property BACKUP_FOLDER_ID。
 *
 * 在 Apps Script 編輯器：函式選 setupBackupFolder → 執行（首次會跳授權）。
 */
function setupBackupFolder() {
  // 若已存在同名資料夾就拿來用，避免重複建立
  var existing = DriveApp.getFoldersByName('Personal Hub Backups');
  var folder;
  if (existing.hasNext()) {
    folder = existing.next();
  } else {
    folder = DriveApp.createFolder('Personal Hub Backups');
  }
  var id = folder.getId();
  PROP.setProperty('BACKUP_FOLDER_ID', id);
  var info = {
    ok: true,
    id: id,
    name: folder.getName(),
    url: folder.getUrl(),
    owner: Session.getEffectiveUser().getEmail(),
  };
  console.log('[setupBackupFolder] ' + JSON.stringify(info));
  return info;
}

/** 診斷：回報目前 BACKUP_FOLDER_ID 與 Drive 是否能讀到 */
function backupDiag() {
  var raw = PROP.getProperty('BACKUP_FOLDER_ID');
  var parsed = raw ? extractFolderId_(raw) : null;
  var out = {
    rawProp: raw,
    parsedId: parsed,
    effectiveUser: Session.getEffectiveUser().getEmail(),
  };
  if (parsed) {
    try {
      var f = DriveApp.getFolderById(parsed);
      out.folderName = f.getName();
      out.folderUrl = f.getUrl();
      out.folderOwner = (f.getOwner && f.getOwner()) ? f.getOwner().getEmail() : 'shared';
      out.ok = true;
    } catch (err) {
      out.ok = false;
      out.error = String(err && err.message || err);
    }
  }
  return out;
}
