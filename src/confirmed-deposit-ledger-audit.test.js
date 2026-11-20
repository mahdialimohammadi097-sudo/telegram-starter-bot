import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditConfirmedDepositLedger } from './confirmed-deposit-ledger-audit.js';
const key = 'bsc:56:0x'+'b'.repeat(64)+':0';
function fixture(rows) {
  const queries = [];
  let released = false;
  const client = { async query(sql) {
    queries.push(sql);
    if (sql.startsWith('SELECT id::text')) return { rows };
    return { rows: [] };
  }, release() { released = true; } };
  return { pool: { connect: async () => client }, queries, released: () => released };
}
const record = { id: '1', reference_id: key, idempotency_key: 'confirmed-deposit:'+key };
test('missing evidence produces a finding, not a clean ledger result', async () => {
  const f = fixture([record]);
  const result = await auditConfirmedDepositLedger({ pool: f.pool, clearingAccountId: '1',
    resolveExpectedDeposits: async keys => keys.map(eventKey => ({ eventKey, expected: null })) });
  assert.equal(result.clean, false);
  assert.equal(result.scanComplete, true);
  assert.equal(result.findings[0].code, 'unverified_deposit_event');
  assert.ok(f.queries.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(f.queries.includes('COMMIT'));
  assert.ok(f.released());
});
test('source failure and incomplete answers abort the audit and release the client', async () => {
  for (const resolve of [async () => { throw new Error('RPC unavailable'); }, async () => [],
    async () => [{ eventKey: key, expected: { evidence: { eventKey: 'different' } } }]]) {
    const f = fixture([record]);
    await assert.rejects(auditConfirmedDepositLedger({ pool: f.pool, clearingAccountId: '1', resolveExpectedDeposits: resolve }));
    assert.ok(f.queries.includes('ROLLBACK'));
    assert.ok(!f.queries.includes('COMMIT'));
    assert.ok(f.released());
  }
});
test('both malformed identifiers still produce an unidentifiable journal finding', async () => {
  const f = fixture([{ ...record, reference_id: null, idempotency_key: 'broken' }]);
  const result = await auditConfirmedDepositLedger({ pool: f.pool, clearingAccountId: '1',
    resolveExpectedDeposits: async () => { throw new Error('must not call source'); } });
  assert.equal(result.findings[0].code, 'unidentifiable_deposit_journal');
  assert.equal(result.clean, false);
});
test('truncation cannot be reported as a complete or clean audit', async () => {
  const f = fixture([record, { ...record, id: '2' }]);
  const result = await auditConfirmedDepositLedger({ pool: f.pool, clearingAccountId: '1', maxJournals: 1,
    resolveExpectedDeposits: async keys => keys.map(eventKey => ({ eventKey, expected: null })) });
  assert.equal(result.scannedJournals, 1);
  assert.equal(result.scanComplete, false);
  assert.equal(result.clean, false);
});
