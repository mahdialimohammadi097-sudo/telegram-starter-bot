import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { postConfirmedDeposit } from './confirmed-deposit-posting.js';

const enabled = Boolean(process.env.DATABASE_URL);
let admin, pool, schema;
const address = '0x' + 'a'.repeat(40);
const contract = '0x' + 'c'.repeat(40);
const evidence = n => ({ chainId: '56', tokenContract: contract, depositAddress: address,
  eventKey: 'bsc:56:0x' + n.toString(16).padStart(64, '0') + ':0',
  amountBaseUnits: '25000000000000000000', ledgerAmount: '25.00000000' });

before(async () => {
  if (!enabled) return;
  admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  schema = 'deposit_it_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  await pool.query(await readFile(new URL('../test/fixtures/ledger-contract.sql', import.meta.url), 'utf8'));
  // Explicitly synthetic ownership contract; not a FadeHost schema claim.
  await pool.query(`INSERT INTO users VALUES (1), (2);
    INSERT INTO ledger_accounts (id, user_id, account_code, account_type) VALUES
      (1, NULL, 'clearing', 'CLEARING'), (2, 1, 'available-1', 'AVAILABLE'),
      (3, 2, 'available-2', 'AVAILABLE');
    CREATE TABLE test_assignments (user_id bigint, active boolean);
    INSERT INTO test_assignments VALUES (1, true)`);
});
after(async () => {
  if (pool) await pool.end();
  if (admin) { if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});
async function resolve(client) {
  // Blocks inserts and reassignment as well as changes to existing rows.
  await client.query('LOCK TABLE test_assignments IN SHARE MODE');
  const result = await client.query('SELECT * FROM test_assignments');
  return result.rows.map(r => ({ userId: r.user_id, active: r.active, address,
    tokenContract: contract, chainId: 56, currency: 'USDT' }));
}
const post = (n, overrides = {}) => postConfirmedDeposit({ pool, evidence: evidence(n),
  clearingAccountId: '1', resolveAndLockAssignments: resolve, ...overrides });
const count = async () => Number((await pool.query('SELECT count(*) FROM ledger_transactions')).rows[0].count);

test('concurrent confirmed receipts credit exactly once and replay after commit', { skip: !enabled }, async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => post(1)));
  assert.equal(new Set(results.map(r => r.transactionId)).size, 1);
  assert.equal(results.filter(r => !r.idempotent).length, 1);
  assert.equal((await post(1)).idempotent, true);
  const balances = await pool.query(`SELECT account_id, sum(CASE WHEN entry_type='credit' THEN amount ELSE -amount END)::text AS balance
    FROM ledger_entries GROUP BY account_id ORDER BY account_id`);
  assert.equal(Number(balances.rows[0].balance), -25);
  assert.equal(Number(balances.rows[1].balance), 25);
  assert.equal(await count(), 1);
});
test('changed amount and reassigned owner cannot replay an already credited event', { skip: !enabled }, async () => {
  await assert.rejects(post(1, { evidence: { ...evidence(1), amountBaseUnits: '26000000000000000000', ledgerAmount: '26.00000000' } }), /different request/);
  await pool.query('UPDATE test_assignments SET user_id=2');
  try { await assert.rejects(post(1), /different request/); }
  finally { await pool.query('UPDATE test_assignments SET user_id=1'); }
  assert.equal(await count(), 1);
});
test('ambiguous, inactive and missing ownership fail without a journal', { skip: !enabled }, async () => {
  await pool.query('INSERT INTO test_assignments VALUES (2,true)');
  try { await assert.rejects(post(2), /exactly one/); }
  finally { await pool.query('DELETE FROM test_assignments WHERE user_id=2'); }
  await pool.query('UPDATE test_assignments SET active=false');
  try { await assert.rejects(post(2), /mismatch/); }
  finally { await pool.query('UPDATE test_assignments SET active=true'); }
  await assert.rejects(post(2, { resolveAndLockAssignments: async () => [] }), /exactly one/);
  assert.equal(await count(), 1);
});
test('customer AVAILABLE account cannot be used as deposit clearing', { skip: !enabled }, async () => {
  await assert.rejects(post(2, { clearingAccountId: '3' }), /ownership mismatch/);
  assert.equal(await count(), 1);
});
test('posting failure rolls back debit and journal and retry succeeds', { skip: !enabled }, async () => {
  await pool.query(`CREATE FUNCTION reject_deposit_credit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.entry_type='credit' THEN RAISE EXCEPTION 'injected credit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_credit BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_deposit_credit()`);
  try { await assert.rejects(post(3), /injected credit failure/); }
  finally { await pool.query('DROP TRIGGER fail_credit ON ledger_entries'); }
  assert.equal(await count(), 1);
  assert.equal(Number((await pool.query('SELECT count(*) FROM ledger_entries')).rows[0].count), 2);
  assert.equal((await post(3)).idempotent, false);
});
test('ownership lock prevents reassignment until posting commits', { skip: !enabled }, async () => {
  const writer = await pool.connect();
  try {
    await post(4, { resolveAndLockAssignments: async (client, ev) => {
      const owners = await resolve(client, ev);
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(writer.query('UPDATE test_assignments SET user_id=2'), e => e.code === '55P03');
      await writer.query('ROLLBACK');
      return owners;
    } });
  } finally { await writer.query('ROLLBACK'); writer.release(); }
});

const { reconcileConfirmedDeposits } = await import('./confirmed-deposit-reconciliation.js');
const { postLedgerTransaction } = await import('./ledger-posting.js');
const expectedDeposit = n => ({ evidence: evidence(n), availableAccountId: '2', assignments: [{
  userId: '1', active: true, chainId: 56, currency: 'USDT', address, tokenContract: contract
}] });

test('confirmed deposit reconciliation matches posted journals and detects missing evidence without writes', { skip: !enabled }, async () => {
  const before = await count();
  const report = await reconcileConfirmedDeposits(pool, [1,3,4,99].map(expectedDeposit), '1');
  assert.equal(report.checkedEvents, 4);
  assert.equal(report.matchedEvents, 3);
  assert.deepEqual(report.findings.map(f => f.code), ['missing_journal']);
  assert.equal(report.findings[0].eventKey, evidence(99).eventKey);
  assert.equal(await count(), before);
});
test('reconciliation catches wrong amount, recipient, metadata and transaction identity', { skip: !enabled }, async () => {
  for (const [n, change, expectedCode] of [
    [10, { amount: '24' }, 'ledger_entries_mismatch'],
    [11, { destination: '3' }, 'ledger_entries_mismatch'],
    [12, { description: '{broken' }, 'attribution_mismatch'],
    [13, { transactionType: 'other-credit' }, 'journal_identity_mismatch']
  ]) {
    const e = evidence(n);
    await postLedgerTransaction({ pool, transactionType: change.transactionType ?? 'confirmed-deposit',
      referenceId: e.eventKey, idempotencyKey: 'confirmed-deposit:' + e.eventKey,
      description: change.description ?? JSON.stringify({ userId: '1', address, tokenContract: contract }),
      entries: [{ account_id: '1', entry_type: 'debit', amount: change.amount ?? '25', currency: 'USDT' },
        { account_id: change.destination ?? '2', entry_type: 'credit', amount: change.amount ?? '25', currency: 'USDT' }] });
    const report = await reconcileConfirmedDeposits(pool, [expectedDeposit(n)], '1');
    assert.equal(report.matchedEvents, 0);
    assert.ok(report.findings.some(f => f.code === expectedCode));
  }
});
test('reconciliation catches duplicate event journals and pending entries', { skip: !enabled }, async () => {
  const e = evidence(1);
  await postLedgerTransaction({ pool, transactionType: 'confirmed-deposit', referenceId: e.eventKey,
    idempotencyKey: 'incorrect-second-key', description: JSON.stringify({ userId: '1', address, tokenContract: contract }),
    entries: [{ account_id: '1', entry_type: 'debit', amount: '25', currency: 'USDT' },
      { account_id: '2', entry_type: 'credit', amount: '25', currency: 'USDT' }] });
  await pool.query(`INSERT INTO ledger_transactions(transaction_type,reference_id,idempotency_key,status)
    VALUES ('confirmed-deposit',$1,$2,'pending')`, [evidence(14).eventKey, 'confirmed-deposit:'+evidence(14).eventKey]);
  const report = await reconcileConfirmedDeposits(pool, [1,14].map(expectedDeposit), '1');
  assert.equal(report.matchedEvents, 0);
  assert.ok(report.findings.some(f => f.code === 'duplicate_journal'));
  assert.ok(report.findings.some(f => f.code === 'journal_not_posted'));
});
