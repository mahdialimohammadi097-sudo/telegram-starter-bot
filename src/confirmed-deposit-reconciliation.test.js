import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileConfirmedDeposits } from './confirmed-deposit-reconciliation.js';
const evidence = { chainId: '56', tokenContract: '0x'+'c'.repeat(40), depositAddress: '0x'+'a'.repeat(40),
  eventKey: 'bsc:56:0x'+'b'.repeat(64)+':0', amountBaseUnits: '1000000000000000000', ledgerAmount: '1.00000000' };
const input = { evidence, availableAccountId: '2', assignments: [{ userId: '1', active: true,
  chainId: 56, currency: 'USDT', address: evidence.depositAddress, tokenContract: evidence.tokenContract }] };
const noDb = { query() { throw new Error('must not query database'); } };
test('reconciliation rejects empty, unbounded and duplicate batches before SQL', async () => {
  for (const batch of [[], Array(501).fill(input), [input,input]]) {
    await assert.rejects(reconcileConfirmedDeposits(noDb, batch, '1'), /Provide|Duplicate/);
  }
});
test('reconciliation requires exact evidence and unambiguous independent ownership', async () => {
  for (const item of [{ ...input, evidence: { ...evidence, ledgerAmount: '2.00000000' } },
    { ...input, assignments: [] }, { ...input, availableAccountId: 2 }]) {
    await assert.rejects(reconcileConfirmedDeposits(noDb, [item], '1'));
  }
});
test('reconciliation executes one read-only parameterized snapshot and reports missing events', async () => {
  let calls = 0;
  const result = await reconcileConfirmedDeposits({ async query(sql, args) {
    calls++;
    assert.match(sql, /^SELECT/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i);
    assert.deepEqual(args, [[evidence.eventKey], ['confirmed-deposit:'+evidence.eventKey]]);
    return { rows: [] };
  } }, [input], '1');
  assert.equal(calls, 1);
  assert.equal(result.scope, 'supplied-events-only');
  assert.equal(result.matchedEvents, 0);
  assert.equal(result.findings[0].code, 'missing_journal');
});
