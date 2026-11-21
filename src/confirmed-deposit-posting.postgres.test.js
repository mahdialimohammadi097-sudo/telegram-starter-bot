import { auditConfirmedDepositLedger } from './confirmed-deposit-ledger-audit.js';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { postConfirmedDeposit } from './confirmed-deposit-posting.js';
import {persistVerifiedDepositEvidence} from './verified-deposit-evidence-store.js';

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
  await pool.query(await readFile(new URL('../test/fixtures/verified-deposit-evidence.sql', import.meta.url), 'utf8'));
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
  clearingAccountId: '1', resolveAndLockAssignments: resolve,
  persistVerifiedEvidence: persistVerifiedDepositEvidence, ...overrides });
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

test('ledger-first audit verifies a complete clean deposit set before fault fixtures are introduced', { skip: !enabled }, async () => {
  const report = await auditConfirmedDepositLedger({ pool, clearingAccountId: '1', pageSize: 1,
    resolveExpectedDeposits: async keys => keys.map(eventKey => ({ eventKey,
      expected: expectedDeposit(Number(BigInt(eventKey.split(':')[2]))) })) });
  assert.equal(report.scannedJournals, 3);
  assert.equal(report.checkedEvents, 3);
  assert.equal(report.scanComplete, true);
  assert.equal(report.clean, true);
  assert.deepEqual(report.findings, []);
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

test('ledger-first audit scans all pages in read-only snapshot and finds unsupported and corrupt journals', { skip: !enabled }, async () => {
  await pool.query(`INSERT INTO ledger_transactions(transaction_type,reference_id,idempotency_key,status)
    VALUES ('confirmed-deposit','corrupt-ref','corrupt-key','pending')`);
  const before = await count();
  let sourceCalls = 0;
  const report = await auditConfirmedDepositLedger({ pool, clearingAccountId: '1', pageSize: 2,
    resolveExpectedDeposits: async keys => {
      sourceCalls++;
      return keys.map(eventKey => ({ eventKey, expected: eventKey === evidence(14).eventKey ? null :
        expectedDeposit(Number(BigInt('0x'+eventKey.split(':')[2].slice(2)))) }));
    } });
  assert.ok(sourceCalls > 1);
  assert.equal(report.scannedJournals, before);
  assert.equal(report.scanComplete, true);
  assert.equal(report.clean, false);
  for (const code of ['unidentifiable_deposit_journal','unverified_deposit_event','duplicate_journal','ledger_entries_mismatch']) {
    assert.ok(report.findings.some(f => f.code === code), code);
  }
  assert.equal(await count(), before);
});
test('ledger audit is a consistent snapshot across concurrent commits and a fresh run includes late commits', { skip: !enabled }, async () => {
  let inserted = false;
  const resolver = async keys => {
    if (!inserted) {
      inserted = true;
      await post(88);
    }
    return keys.map(eventKey => ({ eventKey, expected: null }));
  };
  const before = await count();
  const first = await auditConfirmedDepositLedger({ pool, clearingAccountId: '1', pageSize: 2, resolveExpectedDeposits: resolver });
  assert.equal(first.scannedJournals, before);
  const second = await auditConfirmedDepositLedger({ pool, clearingAccountId: '1', pageSize: 2, resolveExpectedDeposits: resolver });
  assert.equal(second.scannedJournals, before + 1);
  const limited = await auditConfirmedDepositLedger({ pool, clearingAccountId: '1', maxJournals: 1, resolveExpectedDeposits: resolver });
  assert.equal(limited.scanComplete, false);
  assert.equal(limited.clean, false);
});

test('verified BEP20 receipt posts one atomic PostgreSQL journal and replays idempotently', { skip: !enabled }, async () => {
  const { rehearseVerifiedBep20Deposit } = await import('./bep20-deposit-rehearsal.js');
  const txHash = '0x' + 'f'.repeat(64);
  const blockHash = '0x' + 'e'.repeat(64);
  const block = {hash:blockHash, number:'0x64'};
  const transaction = {hash:txHash, blockHash, blockNumber:'0x64'};
  const log = {
    address:contract,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x' + '0'.repeat(24) + 'b'.repeat(40),
      '0x' + '0'.repeat(24) + address.slice(2)
    ],
    data:'0x' + (25n * 10n ** 18n).toString(16).padStart(64,'0'),
    logIndex:'0x0', transactionHash:txHash, blockHash
  };
  const receipt = {transactionHash:txHash, blockHash, blockNumber:'0x64', status:'0x1', logs:[log]};
  const args = {pool, receipt, transaction, block, head:'0x77',
    tokenContract:contract, depositAddress:address, clearingAccountId:'1',
    resolveAndLockAssignments:resolve};
  const before = await count();
  const first = await rehearseVerifiedBep20Deposit(args);
  assert.equal(first.idempotent, false);
  assert.equal((await rehearseVerifiedBep20Deposit(args)).idempotent, true);
  assert.equal(await count(), before + 1);
  const persisted = await pool.query('SELECT block_hash,amount_base_units::text AS amount FROM verified_deposit_evidence WHERE event_key=$1',['bsc:56:'+txHash+':0']);
  assert.equal(persisted.rowCount,1);
  assert.equal(persisted.rows[0].block_hash,blockHash);
  assert.equal(persisted.rows[0].amount,'25000000000000000000');
  const journal = await pool.query(
    `SELECT le.entry_type, le.amount::text AS amount, la.account_type
       FROM ledger_entries le JOIN ledger_accounts la ON la.id = le.account_id
       JOIN ledger_transactions lt ON lt.id = le.transaction_id
      WHERE lt.idempotency_key = $1 ORDER BY le.id`,
    ['confirmed-deposit:bsc:56:' + txHash + ':0']);
  assert.deepEqual(journal.rows.map(r=>[r.entry_type,r.amount,r.account_type]),[
    ['debit','25.000000000000000000','CLEARING'],
    ['credit','25.000000000000000000','AVAILABLE']
  ]);
  // A replay with the same tx/log identity but a different block is a
  // potential reorg: it must not credit a second time or silently succeed.
  const reorgHash='0x'+'7'.repeat(64);
  const changedReceipt={...receipt,blockHash:reorgHash,
    logs:receipt.logs.map(log=>({...log,blockHash:reorgHash}))};
  await assert.rejects(rehearseVerifiedBep20Deposit({...args,
    receipt:changedReceipt,transaction:{...transaction,blockHash:reorgHash},
    block:{...block,hash:reorgHash}}),/Conflicting verified deposit evidence/);
  assert.equal(await count(),before+1);
  await assert.rejects(rehearseVerifiedBep20Deposit({...args, head:'0x76'}), /Insufficient confirmations/);
  assert.equal(await count(), before + 1);
});

test('failed atomic journal rolls back newly persisted blockchain evidence', { skip: !enabled }, async () => {
  const { rehearseVerifiedBep20Deposit } = await import('./bep20-deposit-rehearsal.js');
  const txHash='0x'+'9'.repeat(64), blockHash='0x'+'8'.repeat(64);
  const block={hash:blockHash,number:'0x65'};
  const transaction={hash:txHash,blockHash,blockNumber:'0x65'};
  const receipt={transactionHash:txHash,blockHash,blockNumber:'0x65',status:'0x1',
    logs:[{address:contract,topics:[
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x'+'0'.repeat(24)+'b'.repeat(40),
      '0x'+'0'.repeat(24)+address.slice(2)],
      data:'0x'+(25n*10n**18n).toString(16).padStart(64,'0'),
      logIndex:'0x0',transactionHash:txHash,blockHash}]};
  const args={pool,receipt,transaction,block,head:'0x78',tokenContract:contract,
    depositAddress:address,clearingAccountId:'1',resolveAndLockAssignments:resolve};
  const before=await count();
  await pool.query(`CREATE FUNCTION reject_atomic_receipt_credit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.entry_type='credit' THEN RAISE EXCEPTION 'injected atomic failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_atomic_receipt_credit BEFORE INSERT ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION reject_atomic_receipt_credit()`);
  try { await assert.rejects(rehearseVerifiedBep20Deposit(args),/injected atomic failure/); }
  finally { await pool.query('DROP TRIGGER reject_atomic_receipt_credit ON ledger_entries'); }
  assert.equal(await count(),before);
  const stored=await pool.query('SELECT count(*)::int AS n FROM verified_deposit_evidence WHERE event_key=$1',
    ['bsc:56:'+txHash+':0']);
  assert.equal(stored.rows[0].n,0);
  assert.equal((await rehearseVerifiedBep20Deposit(args)).idempotent,false);
});

test('missing evidence table prevents a journal even when ownership and receipt are valid', { skip: !enabled }, async () => {
  const { rehearseVerifiedBep20Deposit } = await import('./bep20-deposit-rehearsal.js');
  const txHash='0x'+'6'.repeat(64), blockHash='0x'+'5'.repeat(64);
  const block={hash:blockHash,number:'0x66'};
  const transaction={hash:txHash,blockHash,blockNumber:'0x66'};
  const receipt={transactionHash:txHash,blockHash,blockNumber:'0x66',status:'0x1',
    logs:[{address:contract,topics:[
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x'+'0'.repeat(24)+'b'.repeat(40),
      '0x'+'0'.repeat(24)+address.slice(2)],
      data:'0x'+(25n*10n**18n).toString(16).padStart(64,'0'),
      logIndex:'0x0',transactionHash:txHash,blockHash}]};
  const args={pool,receipt,transaction,block,head:'0x79',tokenContract:contract,
    depositAddress:address,clearingAccountId:'1',resolveAndLockAssignments:resolve};
  const before=await count();
  await pool.query('ALTER TABLE verified_deposit_evidence RENAME TO unavailable_evidence_fixture');
  try {
    await assert.rejects(rehearseVerifiedBep20Deposit(args), e => e.code==='42P01');
    assert.equal(await count(),before);
  } finally {
    await pool.query('ALTER TABLE unavailable_evidence_fixture RENAME TO verified_deposit_evidence');
  }
  assert.equal((await rehearseVerifiedBep20Deposit(args)).idempotent,false);
  assert.equal(await count(),before+1);
});
