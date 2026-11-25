import test from 'node:test';
import assert from 'node:assert/strict';
import { postConfirmedDeposit } from './confirmed-deposit-posting.js';
const evidence = { eventKey: 'bsc:56:0x' + 'a'.repeat(64) + ':0',
  amountBaseUnits: '1000000000000000000', ledgerAmount: '1.00000000' };
const persistVerifiedEvidence = async () => {};
const pool = { connect() { throw new Error('must not open database'); } };
test('missing ownership adapter and amount mismatch fail before database access', async () => {
  await assert.rejects(postConfirmedDeposit({ pool, persistVerifiedEvidence, evidence }), /adapter/);
  await assert.rejects(postConfirmedDeposit({ pool, persistVerifiedEvidence, evidence: { ...evidence, ledgerAmount: '2.00000000' },
    resolveAndLockAssignments() {} }), /does not match/);
});
test('noncanonical event identities cannot bypass idempotency', async () => {
  for (const eventKey of [evidence.eventKey.toUpperCase(), evidence.eventKey + '0', evidence.eventKey.slice(0,-1)+(1n<<256n).toString(), evidence.eventKey.slice(0,-1)+'9'.repeat(100)]) {
    await assert.rejects(postConfirmedDeposit({ pool, persistVerifiedEvidence, evidence: { ...evidence, eventKey },
      resolveAndLockAssignments() {} }), /canonical/);
  }
});

test('posting refuses missing durable evidence adapter before opening database',async()=>{
 await assert.rejects(postConfirmedDeposit({pool,evidence,resolveAndLockAssignments(){}}),/Durable verified evidence/);
});

test("invalid clearing identifiers fail before opening a database transaction", async () => {
  for (const clearingAccountId of [Number.MAX_SAFE_INTEGER + 1, "9223372036854775808", "1".repeat(200), { toString: () => "42" }]) {
    await assert.rejects(postConfirmedDeposit({ pool, evidence, clearingAccountId, persistVerifiedEvidence,
      resolveAndLockAssignments() {} }), /Invalid clearing account/);
  }
});
