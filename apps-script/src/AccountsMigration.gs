/**
 * Accounts migration dry-run.
 *
 * Phase 1 contract:
 * - Read legacy payment_methods / cash_accounts / liabilities.
 * - Build candidate accounts and paymentMethod -> accountId mapping.
 * - Report matched / unmatched / ambiguous transactions.
 * - Do not write accounts or transactions.
 */

function dryRunAccountsMigration() {
  var now = new Date();
  var candidates = buildAccountCandidates_();
  var mapping = {};
  var ambiguousKeys = {};

  candidates.forEach(function (account) {
    if (!account.legacyPaymentMethod) return;
    var key = normalizeAccountKey_(account.legacyPaymentMethod);
    if (!mapping[key]) mapping[key] = [];
    mapping[key].push(account);
  });
  Object.keys(mapping).forEach(function (key) {
    if (mapping[key].length > 1) ambiguousKeys[key] = mapping[key].map(function (a) { return a.id; });
  });

  var txs = fsListAllDocs_('transactions', 1000);
  var report = {
    ok: true,
    generatedAt: now,
    candidateAccounts: candidates,
    totals: {
      candidates: candidates.length,
      transactionsScanned: txs.length,
      matched: 0,
      ambiguous: 0,
      unmatched: 0,
      alreadyLinked: 0,
      skippedTransfers: 0,
    },
    ambiguous: [],
    unmatched: [],
    notes: [
      'dry-run only: no Firestore writes were performed',
      'review candidateAccounts and ambiguous/unmatched rows before commit migration',
    ],
  };

  txs.forEach(function (tx) {
    var txId = (tx._name || '').split('/').pop();
    if (tx.type === 'transfer') {
      report.totals.skippedTransfers += 1;
      return;
    }
    if (tx.fromAccountId || tx.toAccountId) {
      report.totals.alreadyLinked += 1;
      return;
    }
    var legacy = tx.paymentMethod || '';
    var normalized = normalizeAccountKey_(legacy);
    var matches = mapping[normalized] || [];
    if (matches.length === 1) {
      report.totals.matched += 1;
      return;
    }
    if (matches.length > 1) {
      report.totals.ambiguous += 1;
      report.ambiguous.push({
        txId: txId,
        paymentMethod: legacy,
        candidateAccountIds: matches.map(function (a) { return a.id; }),
      });
      return;
    }
    report.totals.unmatched += 1;
    report.unmatched.push({
      txId: txId,
      paymentMethod: legacy,
      type: tx.type,
      amountTWD: tx.amountTWD || 0,
      date: tx.date || null,
    });
  });

  return report;
}

function buildAccountCandidates_() {
  var out = [];
  var seen = {};

  function pushCandidate(account) {
    var id = account.id;
    if (seen[id]) return;
    seen[id] = true;
    out.push(account);
  }

  try {
    fsListAllDocs_('payment_methods', 200).forEach(function (pm) {
      if (pm.archivedAt) return;
      var id = 'legacy_pm_' + normalizeAccountKey_(pm.key || pm.name || 'payment');
      var type = pm.type === 'credit' ? 'credit_card'
        : pm.type === 'cash' ? 'cash'
        : pm.type === 'mobile' ? 'e_wallet_balance'
        : 'bank';
      pushCandidate({
        id: id,
        ownerId: null,
        name: pm.name || pm.key || id,
        type: type,
        currency: 'TWD',
        active: true,
        balance: 0,
        balanceTWD: 0,
        legacyPaymentMethod: pm.name || pm.key || null,
        legacySource: 'payment_methods',
      });
    });
  } catch (err) {
    console.warn('accounts dry-run payment_methods', err);
  }

  try {
    fsListAllDocs_('cash_accounts', 200).forEach(function (cash) {
      if (cash.archivedAt) return;
      pushCandidate({
        id: 'legacy_cash_' + normalizeAccountKey_(cash.name || cash._name || 'cash'),
        ownerId: null,
        name: cash.name || 'Cash account',
        type: cash.type === 'cash' ? 'cash' : 'bank',
        currency: cash.currency || 'TWD',
        active: true,
        balance: cash.amount || 0,
        balanceTWD: cash.amountTWD || cash.amount || 0,
        legacyPaymentMethod: cash.name || null,
        legacySource: 'cash_accounts',
      });
    });
  } catch (err2) {
    console.warn('accounts dry-run cash_accounts', err2);
  }

  try {
    fsListAllDocs_('liabilities', 200).forEach(function (liability) {
      if (liability.archivedAt) return;
      pushCandidate({
        id: 'legacy_liability_' + normalizeAccountKey_(liability.name || liability._name || 'loan'),
        ownerId: null,
        name: liability.name || 'Loan',
        type: 'loan',
        currency: 'TWD',
        active: true,
        balance: liability.balanceTWD || 0,
        balanceTWD: liability.balanceTWD || 0,
        legacyPaymentMethod: liability.name || null,
        legacySource: 'liabilities',
      });
    });
  } catch (err3) {
    console.warn('accounts dry-run liabilities', err3);
  }

  return out;
}

function normalizeAccountKey_(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}
