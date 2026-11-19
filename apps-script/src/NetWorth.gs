/**
 * Net worth monthly snapshot
 *
 * 與 portfolio snapshot 一樣每天跑兩次（07:00 / 18:00），doc id = YYYY-MM（台北時區）。
 * 同月覆寫；月份切換 → 自動寫入下個月 doc，過去月份永遠不再被觸碰（凍結）。
 *
 * 公式：
 *   liquidTWD          = sum(accounts asset-like balanceTWD)
 *   investmentTWD      = latest portfolio_snapshots.totalValueTWD（沒有就 0）
 *   manualAssetsTWD    = sum(manual_assets not archived).valueTWD
 *   insurancePensionTWD = sum(accounts type=insurance insurance.cashValueTWD) + sum(accounts type=pension 現值)
 *     保單只計解約金 / 保單價值，純保障型 = 0（前端 accounts/valuation.ts longTermAccountValueTWD 同口徑）
 *   rentalUnrecoveredTWD = sum(active rentals max(0, purchaseAmountTWD − sum(incomes.amountTWD)))
 *     虛擬資產：購入時錢已從現金 / 銀行扣，這條用來抵銷那筆扣減；
 *     租金進來會降低未回收成本到 0，再之後的收入直接以現金形式進帳。
 *   liabilitiesTWD     = sum(accounts type=loan balanceTWD)
 *   creditCardOutstandingTWD = sum(accounts type=credit_card balanceTWD), fallback overdue bills
 *   installmentRemainingTWD = sum(active installment_plans 尚未入帳的期數金額)（Installments.gs installmentRemainingTWD_）
 *     已入帳的期數已經在信用卡餘額裡，這裡只算未來還沒進卡片的部分，不會重複計算。
 *   netWorthTWD        = liquid + investment + manual + insurancePension + rentalUnrecovered − liabilities − cc − installmentRemaining
 *
 * 外幣帳戶：用快照當下的 fx_rates 重估（與前端 accounts/valuation.ts currentAccountBalanceTWD 同口徑）。
 * 以前直接加總凍結的 balanceTWD，外幣帳戶多時首頁淨值與月快照會對不起來（2026-11 稽核 D4）。
 * pitfall #3 的「匯率凍結」只適用於單筆交易的 amountTWD，不是帳戶餘額的現值。
 * 讀不到匯率時才退回 balanceTWD。
 */

var netWorthFxCache_ = {};

function netWorthFxRate_(currency) {
  if (!currency || currency === 'TWD') return 1;
  if (netWorthFxCache_[currency] !== undefined) return netWorthFxCache_[currency];
  var rate = null;
  try {
    var d = fsGetDoc_('fx_rates/' + currency + '_TWD');
    if (d && Number(d.rate) > 0) rate = Number(d.rate);
  } catch (err) { console.warn('netWorthFxRate_', currency, err); }
  netWorthFxCache_[currency] = rate;
  return rate;
}

function accountBalanceTWD_(account) {
  var balance = Number(account.balance);
  var currency = account.currency || 'TWD';
  if (currency === 'TWD' && !isNaN(balance)) return balance;
  if (currency !== 'TWD' && !isNaN(balance)) {
    var rate = netWorthFxRate_(currency);
    if (rate) return balance * rate;
  }
  if (account.balanceTWD !== null && account.balanceTWD !== undefined && account.balanceTWD !== '') {
    var storedTWD = Number(account.balanceTWD);
    if (!isNaN(storedTWD)) return storedTWD;
  }
  return 0;
}

/** 保單對淨值的貢獻：只有 cashValueTWD（解約金 / 保單價值）；沒填或非正數 = 0 */
function insuranceCashValueTWD_(account) {
  if (!account || account.type !== 'insurance') return 0;
  var value = Number(account.insurance && account.insurance.cashValueTWD);
  return isFinite(value) && value > 0 ? value : 0;
}

function netWorthAccountKey_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function addNetWorthKeys_(set, values) {
  values.forEach(function (value) {
    var key = netWorthAccountKey_(value);
    if (key) set[key] = true;
  });
}

function legacyCashAmountTWD_(cash) {
  var storedTWD = Number(cash.amountTWD);
  if (!isNaN(storedTWD)) return storedTWD;
  var amount = Number(cash.amount);
  if (!isNaN(amount)) return amount;
  return 0;
}

function snapshotNetWorthMonthly() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { ok: false, error: 'could not acquire lock' };
  }
  netWorthFxCache_ = {};
  try {
    var liquid = 0;
    var liabilities = 0;
    var creditCardBalance = 0;
    var insurancePension = 0;
    var liquidAccountKeys = {};
    var representedCashAccountKeys = {};
    try {
      fsListAllDocs_('accounts', 500).forEach(function (a) {
        if (a.archivedAt || a.active === false) return;
        var value = accountBalanceTWD_(a);
        if (a.type === 'cash' || a.type === 'bank' || a.type === 'e_wallet_balance' || a.type === 'investment_cash') {
          liquid += value;
          addNetWorthKeys_(liquidAccountKeys, [a.name, a.legacyPaymentMethod]);
          if (a.legacySource === 'cash_accounts') {
            addNetWorthKeys_(representedCashAccountKeys, [a.name, a.legacyPaymentMethod]);
          }
        } else if (a.type === 'loan') {
          liabilities += Math.max(0, value);
        } else if (a.type === 'credit_card') {
          creditCardBalance += Math.max(0, value);
        } else if (a.type === 'insurance') {
          insurancePension += insuranceCashValueTWD_(a);
        } else if (a.type === 'pension') {
          insurancePension += value;
        }
      });
    } catch (err) { console.warn('netWorth accounts', err); }

    try {
      fsListAllDocs_('cash_accounts', 200).forEach(function (cash) {
        if (cash.archivedAt) return;
        var keys = [
          cash._name,
          cash.name,
          cash.bank ? String(cash.bank) + '_' + String(cash.name || '') : '',
        ].map(netWorthAccountKey_).filter(function (key) { return key; });
        var represented = keys.some(function (key) {
          return liquidAccountKeys[key] || representedCashAccountKeys[key];
        });
        if (!represented) liquid += legacyCashAmountTWD_(cash);
      });
    } catch (errCash) { console.warn('netWorth cash_accounts', errCash); }

    var manual = 0;
    try {
      fsListAllDocs_('manual_assets', 200).forEach(function (a) {
        if (a.archivedAt) return;
        manual += Number(a.valueTWD || 0);
      });
    } catch (err) { console.warn('netWorth manual_assets', err); }

    var rentalUnrecovered = 0;
    try {
      fsListAllDocs_('rentals', 200).forEach(function (r) {
        if (r.archivedAt) return;
        if (r.status && r.status !== 'active') return;
        var cost = Number(r.purchaseAmountTWD || 0);
        if (cost <= 0) return;
        var received = 0;
        if (Array.isArray(r.incomes)) {
          r.incomes.forEach(function (inc) {
            received += Number((inc && inc.amountTWD) || 0);
          });
        }
        var remaining = cost - received;
        if (remaining > 0) rentalUnrecovered += remaining;
      });
    } catch (err) { console.warn('netWorth rentals', err); }

    var investment = 0;
    try {
      var latest = fsRunQuery_('', {
        from: [{ collectionId: 'portfolio_snapshots' }],
        orderBy: [{ field: { fieldPath: 'date' }, direction: 'DESCENDING' }],
        limit: 1,
      });
      if (latest && latest[0] && latest[0].totalValueTWD != null) {
        investment = Number(latest[0].totalValueTWD || 0);
      }
    } catch (err) { console.warn('netWorth latest portfolio snapshot', err); }

    var overdueBillOutstanding = 0;
    var todayMs = new Date().getTime();
    try {
      fsListAllDocs_('credit_card_bills', 500).forEach(function (b) {
        if (b.paidAt) return;
        if (b.amount == null) return;
        var due = b.dueDateOverride || b.dueDate;
        var dueMs = due ? new Date(due).getTime() : null;
        if (dueMs == null || isNaN(dueMs)) return;
        if (dueMs > todayMs) return; // 尚未到期不計
        overdueBillOutstanding += Number(b.amount || 0);
      });
    } catch (err) { console.warn('netWorth credit_card_bills', err); }
    var ccOutstanding = creditCardBalance > 0 ? creditCardBalance : overdueBillOutstanding;

    // 分期未入帳：與前端 features/installments/schedule.ts totalInstallmentRemainingTWD 同口徑
    var installmentRemaining = 0;
    try {
      fsListAllDocs_('installment_plans', 200).forEach(function (plan) {
        installmentRemaining += installmentRemainingTWD_(plan);
      });
    } catch (err) { console.warn('netWorth installment_plans', err); }

    var netWorth = liquid + investment + manual + insurancePension + rentalUnrecovered - liabilities - ccOutstanding - installmentRemaining;
    var month = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');

    var docData = {
      month: month,
      liquidTWD: round2_(liquid),
      investmentTWD: round2_(investment),
      manualAssetsTWD: round2_(manual),
      insurancePensionTWD: round2_(insurancePension),
      rentalUnrecoveredTWD: round2_(rentalUnrecovered),
      liabilitiesTWD: round2_(liabilities),
      creditCardOutstandingTWD: round2_(ccOutstanding),
      installmentRemainingTWD: round2_(installmentRemaining),
      netWorthTWD: round2_(netWorth),
      createdAt: new Date(),
    };

    fsSetDoc_('net_worth_snapshots/' + month, docData, false);
    return {
      ok: true,
      month: month,
      netWorthTWD: docData.netWorthTWD,
      liquidTWD: docData.liquidTWD,
      investmentTWD: docData.investmentTWD,
      manualAssetsTWD: docData.manualAssetsTWD,
      insurancePensionTWD: docData.insurancePensionTWD,
      rentalUnrecoveredTWD: docData.rentalUnrecoveredTWD,
      liabilitiesTWD: docData.liabilitiesTWD,
      creditCardOutstandingTWD: docData.creditCardOutstandingTWD,
      installmentRemainingTWD: docData.installmentRemainingTWD,
    };
  } finally {
    lock.releaseLock();
  }
}
