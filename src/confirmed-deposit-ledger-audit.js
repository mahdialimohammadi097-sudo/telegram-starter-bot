import { withLedgerTransaction } from './ledger-posting.js';
import { reconcileConfirmedDeposits } from './confirmed-deposit-reconciliation.js';

const EVENT = /^bsc:56:0x[0-9a-f]{64}:(?:0|[1-9][0-9]*)$/;
const PREFIX = 'confirmed-deposit:';

// Audit the ledger -> independent evidence direction. The source adapter must
// query trusted chain evidence and historical ownership, not infer expectations
// from ledger entries. null means evidence is unavailable; RPC/source errors
// must throw, never return an empty successful result. No bot/runtime wiring.
export async function auditConfirmedDepositLedger({ pool, clearingAccountId,
  resolveExpectedDeposits, maxJournals = 1000, pageSize = 100 }) {
  if (typeof resolveExpectedDeposits !== 'function') throw new TypeError('Independent evidence resolver required');
  if (!Number.isSafeInteger(maxJournals) || maxJournals < 1 || maxJournals > 5000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError('Invalid deposit audit limits');
  }
  if (typeof clearingAccountId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(clearingAccountId) ||
      BigInt(clearingAccountId) > 9223372036854775807n) throw new TypeError('Invalid clearing account');
  return withLedgerTransaction(pool, async client => {
    // All pages and comparisons share ONE snapshot. Never reuse a numeric ID
    // cursor across runs: PostgreSQL sequence order is not commit order.
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const findings = [];
    const seenFindings = new Set();
    const seenEvents = new Set();
    const add = finding => {
      const key = JSON.stringify(finding);
      if (!seenFindings.has(key)) { findings.push(finding); seenFindings.add(key); }
    };
    let cursor = '0';
    let scannedJournals = 0;
    let scanComplete = false;
    while (true) {
      const take = Math.min(pageSize, maxJournals - scannedJournals);
      // The extra row proves whether the configured bound truncated the scan.
      const { rows } = await client.query(
        `SELECT id::text, reference_id, idempotency_key FROM ledger_transactions
         WHERE id > $1::bigint AND (transaction_type = 'confirmed-deposit'
           OR idempotency_key LIKE 'confirmed-deposit:%' OR reference_id LIKE 'bsc:56:%')
         ORDER BY id LIMIT $2`, [cursor, take + 1]);
      const page = rows.slice(0, take);
      if (!page.length) { scanComplete = rows.length === 0; break; }
      const events = new Set();
      for (const journal of page) {
        const ids = new Set();
        if (EVENT.test(journal.reference_id ?? '')) ids.add(journal.reference_id);
        const fromKey = journal.idempotency_key?.startsWith(PREFIX) ? journal.idempotency_key.slice(PREFIX.length) : '';
        if (EVENT.test(fromKey)) ids.add(fromKey);
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
          const result = await reconcileConfirmedDeposits(client, verified, clearingAccountId);
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
