import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditConfirmedDepositLedger } from './confirmed-deposit-ledger-audit.js';
const key = 'bsc:56:0x'+'b'.repeat(64)+':0';
function fixture(rows, {readOnly='on', rowSecurity='off'} = {}) {
  const queries = [];
  let released = false;
  const client = { async query(sql) {
    queries.push(sql);
    if (sql.startsWith('SELECT id::text')) return { rows };
    if (sql.startsWith('BEGIN')) return { command: 'BEGIN' };
    if (sql.startsWith('SET LOCAL')) return { command: 'SET' };
    if (sql.includes("current_setting('transaction_read_only')")) return {rows:[{read_only:readOnly,isolation:'repeatable read',statement_timeout:'10s',lock_timeout:'3s'}]};
    if (sql.includes("current_setting('row_security')")) return {rows:[{row_security:rowSecurity,search_path:'pg_catalog'}]};
    if (['COMMIT','ROLLBACK'].includes(sql)) return { command: sql, rows: [], rowCount: 0 };
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
  assert.ok(f.queries.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
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

test('deposit audit rejects unsafe effective settings before querying journals', async()=>{
 for(const settings of [{readOnly:'off'},{rowSecurity:'on'}]){
  const f=fixture([record],settings);
  await assert.rejects(auditConfirmedDepositLedger({pool:f.pool,clearingAccountId:'1',resolveExpectedDeposits:async()=>assert.fail('unexpected resolver')}),/incompatible/);
  assert.equal(f.queries.some(sql=>sql.startsWith('SELECT id::text')),false);
  assert.ok(f.queries.includes('ROLLBACK'));
 }
});
test('audit flags nonpositive IDs and rejects oversized event identities without RPC',async()=>{
 const bad='bsc:56:0x'+'b'.repeat(64)+':'+(1n<<256n).toString();
 const f=fixture([{id:'-1',reference_id:bad,idempotency_key:'confirmed-deposit:'+bad}]);
 const result=await auditConfirmedDepositLedger({pool:f.pool,clearingAccountId:'1',resolveExpectedDeposits:async()=>assert.fail('unexpected resolver')});
 assert.equal(result.clean,false);
 assert.deepEqual(result.findings.map(x=>x.code),['invalid_deposit_journal_id','unidentifiable_deposit_journal']);
});
