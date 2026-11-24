import test from "node:test";
import assert from "node:assert/strict";
import { persistVerifiedDepositEvidence } from "./verified-deposit-evidence-store.js";

const receipt = () => ({
  eventKey: "bsc:56:0x" + "a".repeat(64) + ":0",
  blockHash: "0x" + "b".repeat(64), blockNumber: "123",
  tokenContract: "0x" + "c".repeat(40),
  depositAddress: "0x" + "d".repeat(40),
  amountBaseUnits: "1000000000000000000"
});

test("rejects noncanonical types and out-of-range uint256 evidence before database access", async () => {
  const client = { query() { assert.fail("invalid evidence must never reach SQL"); } };
  for (const patch of [
    { blockNumber: 123 }, { amountBaseUnits: 1000000000000000000 },
    { amountBaseUnits: "0" }, { amountBaseUnits: (1n << 256n).toString() },
    { blockNumber: "1".repeat(79) },
    { eventKey: { toString: () => receipt().eventKey } },
    { blockHash: [receipt().blockHash] }
  ]) {
    await assert.rejects(persistVerifiedDepositEvidence(client, { ...receipt(), ...patch }), /Invalid verified deposit evidence/);
  }
});

test("replay checks and returned identity use the original immutable snapshot", async () => {
  const evidence = receipt();
  const original = { ...evidence };
  let calls = 0;
  const client = { async query(sql, values) {
    calls++;
    if (calls === 1) {
      assert.equal(values[0], original.eventKey);
      evidence.eventKey = "bsc:56:0x" + "f".repeat(64) + ":1";
      evidence.amountBaseUnits = "2";
      return { rowCount: 0 };
    }
    assert.deepEqual(values, [original.eventKey]);
    return { rows: [{ block_hash: original.blockHash, block_number: original.blockNumber,
      token_contract: original.tokenContract, deposit_address: original.depositAddress,
      amount_base_units: original.amountBaseUnits }] };
  } };
  assert.deepEqual(await persistVerifiedDepositEvidence(client, evidence), { inserted: false, eventKey: original.eventKey });
  assert.equal(calls, 2);
});
