import { runReadOnlyDepositAudit } from './read-only-deposit-audit.js';
import { isCanonicalDepositEventKey } from './deposit-owner-guard.js';
import { reconcileConfirmedDeposits } from './confirmed-deposit-reconciliation.js';

const PREFIX = 'confirmed-deposit:';

// Audit the ledger -> independent evidence direction. The source adapter must
// query trusted chain evidence and historical ownership, not infer expectations
// from ledger entries. null means evidence is unavailable; RPC/source errors
// must throw, never return an empty successful result. No bot/runtime wiring.
export async function auditConfirmedDepositLedger({ pool, clearingAccountId,
  resolveExpectedDeposits, maxJournals = 1000, pageSize = 100, schema = 'public' }) {
  if (typeof schema !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid deposit audit schema');
  const qualified = '"' + schema + '"';
  if (typeof resolveExpectedDeposits !== 'function') throw new TypeError('Independent evidence resolver required');
  if (!Number.isSafeInteger(maxJournals) || maxJournals < 1 || maxJournals > 5000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError('Invalid deposit audit limits');
  }
  if (typeof clearingAccountId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(clearingAccountId) ||
      BigInt(clearingAccountId) > 9223372036854775807n) throw new TypeError('Invalid clearing account');
  return runReadOnlyDepositAudit(pool, async client => {
    // Use the shared verified read-only snapshot. Fail rather than silently
    // omit rows hidden by row security or inspect a shadow table.
    const visibility = await client.query("SET LOCAL row_security = off");
    const path = await client.query("SET LOCAL search_path = pg_catalog");
    const state = await client.query("SELECT pg_catalog.current_setting('row_security') AS row_security, pg_catalog.current_setting('search_path') AS search_path");
    if (visibility?.command !== 'SET' || path?.command !== 'SET' ||
        state.rows?.length !== 1 || state.rows[0].row_security !== 'off' ||
        state.rows[0].search_path !== 'pg_catalog') throw new Error('Deposit audit visibility incompatible');
    // Never reuse a numeric cursor across snapshots: sequence order is not commit order.
    const findings = [];
    const seenFindings = new Set();
    const seenEvents = new Set();
    const add = finding => {
      const key = JSON.stringify(finding);
      if (!seenFindings.has(key)) { findings.push(finding); seenFindings.add(key); }
    };
    let cursor = null;
    let scannedJournals = 0;
    let scanComplete = false;
    while (true) {
      const take = Math.min(pageSize, maxJournals - scannedJournals);
      // The extra row proves whether the configured bound truncated the scan.
      const { rows } = await client.query(
        `SELECT id::text, reference_id, idempotency_key FROM ${qualified}.ledger_transactions
         WHERE ($1::bigint IS NULL OR id > $1::bigint) AND (transaction_type = 'confirmed-deposit'
           OR idempotency_key LIKE 'confirmed-deposit:%' OR reference_id LIKE 'bsc:56:%')
         ORDER BY ledger_transactions.id LIMIT $2`, [cursor, take + 1]);
      const page = rows.slice(0, take);
      if (!page.length) { scanComplete = rows.length === 0; break; }
      const events = new Set();
      for (const journal of page) {
        const ids = new Set();
        if (BigInt(journal.id) <= 0n) add({ transactionId: journal.id, eventKey: null, code: 'invalid_deposit_journal_id' });
        if (isCanonicalDepositEventKey(journal.reference_id)) ids.add(journal.reference_id);
        const fromKey = journal.idempotency_key?.startsWith(PREFIX) ? journal.idempotency_key.slice(PREFIX.length) : '';
        if (isCanonicalDepositEventKey(fromKey)) ids.add(fromKey);
        if (ids.size === 0) add({ transactionId: journal.id, eventKey: null, code: 'unidentifiable_deposit_journal' });
        for (const id of ids) if (!seenEvents.has(id)) events.add(id);
      }
      if (events.size) {
        const requested = [...events];
        const resolved = await resolveExpectedDeposits(Object.freeze(requested));
        if (!Array.isArray(resolved) || resolved.length !== requested.length ||
            new Set(resolved.map(r => r?.eventKey)).size !== requested.length ||
            resolved.some(r => !events.has(r?.eventKey) || !Object.hasOwn(r, 'expected'))) {
          throw new Error('Incomplete independent evidence response');
        }
        const verified = [];
        for (const item of resolved) {
          if (item.expected === null) {
            add({ transactionId: null, eventKey: item.eventKey, code: 'unverified_deposit_event' });
          } else {
            if (item.expected?.evidence?.eventKey !== item.eventKey) throw new Error('Evidence event identity mismatch');
            verified.push(item.expected);
          }
          seenEvents.add(item.eventKey);
        }
        if (verified.length) {
          const result = await reconcileConfirmedDeposits(client, verified, clearingAccountId, { schema });
          for (const finding of result.findings) add(finding);
        }
      }
      scannedJournals += page.length;
      cursor = page.at(-1).id;
      if (rows.length <= take) { scanComplete = true; break; }
      if (scannedJournals === maxJournals) break;
    }
    return { scope: 'ledger-to-independent-evidence', scannedJournals,
      checkedEvents: seenEvents.size, scanComplete,
      clean: scanComplete && findings.length === 0, findings };
  });
}
