import test from 'node:test';
import assert from 'node:assert/strict';
import { postConfirmedDeposit } from './confirmed-deposit-posting.js';
const evidence = { eventKey: 'bsc:56:0x' + 'a'.repeat(64) + ':0',
  amountBaseUnits: '1000000000000000000', ledgerAmount: '1.00000000' };
const pool = { connect() { throw new Error('must not open database'); } };
test('missing ownership adapter and amount mismatch fail before database access', async () => {
  await assert.rejects(postConfirmedDeposit({ pool, evidence }), /adapter/);
  await assert.rejects(postConfirmedDeposit({ pool, evidence: { ...evidence, ledgerAmount: '2.00000000' },
    resolveAndLockAssignments() {} }), /does not match/);
});
test('noncanonical event identities cannot bypass idempotency', async () => {
  for (const eventKey of [evidence.eventKey.toUpperCase(), evidence.eventKey + '0']) {
    await assert.rejects(postConfirmedDeposit({ pool, evidence: { ...evidence, eventKey },
      resolveAndLockAssignments() {} }), /canonical/);
  }
});
