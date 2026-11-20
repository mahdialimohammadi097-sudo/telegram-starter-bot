import { requireUniqueDepositOwner } from './deposit-owner-guard.js';
import { bep20BaseUnitsToLedgerAmount } from './bep20-ledger-precision.js';
import { toUsdtUnitsExact } from './ledger-safety.js';

const ID = /^[1-9][0-9]{0,18}$/;
function accountId(value) {
  if (typeof value !== 'string' || !ID.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new TypeError('Expected a canonical bigint account ID string');
  }
  return value;
}

// Read-only reconciliation of a bounded, independently verified evidence batch.
// Ownership must come from the reviewed historical assignment source, never
// reconstructed from the journal being checked. This is NOT a complete chain
// scan: omitted events and journals with both identifiers corrupted are outside
// its scope. No repair, balance change, or financial activation occurs here.
export async function reconcileConfirmedDeposits(pool, expectedDeposits, clearingAccountId) {
  const clearing = accountId(clearingAccountId);
  if (!Array.isArray(expectedDeposits) || expectedDeposits.length < 1 || expectedDeposits.length > 500) {
    throw new TypeError('Provide between 1 and 500 independently verified deposits');
  }
  const expected = expectedDeposits.map(({ evidence, assignments, availableAccountId }) => {
    if (!/^bsc:56:0x[0-9a-f]{64}:(?:0|[1-9][0-9]*)$/.test(evidence?.eventKey ?? '') ||
        bep20BaseUnitsToLedgerAmount(evidence.amountBaseUnits) !== evidence.ledgerAmount) {
      throw new Error('Invalid reconciliation evidence');
    }
    const owner = requireUniqueDepositOwner(evidence, assignments);
    return { ...owner, available: accountId(availableAccountId),
      contract: evidence.tokenContract.toLowerCase(), key: 'confirmed-deposit:' + owner.eventKey };
  });
  if (new Set(expected.map(e => e.eventKey)).size !== expected.length) {
    throw new Error('Duplicate event in reconciliation input');
  }
  // One statement gives metadata, entries and account ownership a single MVCC
  // snapshot, even while deposits are being committed by other workers.
  const { rows } = await pool.query(
    `SELECT t.id::text, t.transaction_type, t.reference_id, t.idempotency_key,
            t.description, t.status,
            COALESCE(jsonb_agg(jsonb_build_object(
              'account_id', e.account_id::text, 'entry_type', e.entry_type,
              'amount', trim_scale(e.amount)::text, 'currency', e.currency,
              'user_id', a.user_id::text, 'account_type', a.account_type,
              'account_currency', a.currency
            )) FILTER (WHERE e.id IS NOT NULL), '[]'::jsonb) AS entries
       FROM ledger_transactions t
       LEFT JOIN ledger_entries e ON e.transaction_id=t.id
       LEFT JOIN ledger_accounts a ON a.id=e.account_id
       WHERE t.reference_id=ANY($1::text[]) OR t.idempotency_key=ANY($2::text[])
       GROUP BY t.id ORDER BY t.id`,
    [expected.map(e => e.eventKey), expected.map(e => e.key)]);
  const findings = [];
  for (const deposit of expected) {
    const journals = rows.filter(t => t.reference_id === deposit.eventKey || t.idempotency_key === deposit.key);
    const report = (code, transactionId = null) => findings.push({ eventKey: deposit.eventKey, transactionId, code });
    if (!journals.length) { report('missing_journal'); continue; }
    if (journals.length !== 1) report('duplicate_journal');
    for (const journal of journals) {
      if (journal.status !== 'posted') report('journal_not_posted', journal.id);
      if (journal.transaction_type !== 'confirmed-deposit' || journal.reference_id !== deposit.eventKey ||
          journal.idempotency_key !== deposit.key) report('journal_identity_mismatch', journal.id);
      let metadata;
      try { metadata = JSON.parse(journal.description); } catch { metadata = null; }
      if (!metadata || metadata.userId !== deposit.userId || metadata.address !== deposit.depositAddress ||
          metadata.tokenContract !== deposit.contract) report('attribution_mismatch', journal.id);
      const matches = (entry, type, id, user, role) => {
        try {
          return entry.entry_type === type && entry.account_id === id && entry.user_id === user &&
            entry.account_type === role && entry.account_currency === 'USDT' && entry.currency === 'USDT' &&
            toUsdtUnitsExact(entry.amount) === toUsdtUnitsExact(deposit.ledgerAmount);
        } catch { return false; }
      };
      if (journal.entries.length !== 2 ||
          journal.entries.filter(e => matches(e, 'debit', clearing, null, 'CLEARING')).length !== 1 ||
          journal.entries.filter(e => matches(e, 'credit', deposit.available, deposit.userId, 'AVAILABLE')).length !== 1) {
        report('ledger_entries_mismatch', journal.id);
      }
    }
  }
  return { scope: 'supplied-events-only', checkedEvents: expected.length,
    matchedEvents: expected.filter(e => !findings.some(f => f.eventKey === e.eventKey)).length,
    findings };
}
