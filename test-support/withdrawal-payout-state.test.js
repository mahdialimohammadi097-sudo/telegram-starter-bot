import test from "node:test";
import assert from "node:assert/strict";
import { confirmTestnetWithdrawal, submitSimulatedWithdrawal, recoverSimulatedWithdrawals } from "./simulated-withdrawal.js";

for (const scenario of [
  { status: "reserved", submitted_hash: null, error: /must be submitted before receipt confirmation/ },
  { status: "pending_receipt", submitted_hash: null, error: /submission hash missing/ }
]) test("receipt confirmation rejects invalid submission state: " + scenario.status, async () => {
  const queries = [];
  let discarded = false;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          queries.push(sql);
          if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
          if (sql.includes("FROM simulation_withdrawals")) {
            return { rows: [{ id: "7", status: scenario.status, submitted_hash: scenario.submitted_hash, destination: "0x1111111111111111111111111111111111111111", amount: "1.00000000" }], rowCount: 1 };
          }
          throw new Error("unexpected database query");
        },
        release(error) { discarded = Boolean(error); }
      };
    }
  };
  await assert.rejects(
    confirmTestnetWithdrawal(pool, "7", {}, { txHash: "0x" + "a".repeat(64) }, { accountId: "1", sender: "0x2222222222222222222222222222222222222222" }),
    scenario.error
  );
  assert.equal(queries[0], "BEGIN");
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.equal(queries.includes("COMMIT"), false);
  assert.equal(discarded, false);
});

for (const sender of [undefined, null, {}, "not a function"]) {
  test("submission refuses an invalid transport without writing to database", async () => {
    let queries = 0;
    const pool = { async query() { queries++; throw new Error("unexpected database write"); } };
    await assert.rejects(
      submitSimulatedWithdrawal(pool, "7", "0x" + "a".repeat(64), sender),
      /Simulation transport sender required/
    );
    assert.equal(queries, 0);
  });
}

for (const transport of [null, {}, { hasTransaction: async () => false }, { send: async () => {} }]) {
  test("recovery refuses an incomplete transport before querying pending withdrawals", async () => {
    let queries = 0;
    const pool = { async query() { queries++; throw new Error("unexpected database read"); } };
    await assert.rejects(recoverSimulatedWithdrawals(pool, transport), /requires a queryable, send-capable transport/);
    assert.equal(queries, 0);
  });
}

for (const lookupResult of [undefined, null, "unknown", 0]) {
  test("recovery fails closed when transaction lookup is indeterminate", async () => {
    let sent = 0;
    const pool = { async query(sql) {
      assert.match(sql, /FROM simulation_withdrawals/);
      return { rows: [{ id: "7", hash: "0x" + "a".repeat(64), amount: "1", destination: "0x" + "1".repeat(40), payload: Buffer.from("test") }] };
    } };
    const transport = { hasTransaction: async () => lookupResult, send: async () => { sent++; } };
    await assert.rejects(recoverSimulatedWithdrawals(pool, transport), /indeterminate transaction status/);
    assert.equal(sent, 0);
  });
}

for (const alreadyKnown of [true, false]) {
  test("recovery " + (alreadyKnown ? "skips" : "resends") + " a known-status synthetic transaction", async () => {
    const hash = "0x" + "a".repeat(64);
    const payload = Buffer.from("synthetic");
    const sent = [];
    const pool = { async query(sql, params) {
      assert.match(sql, /status = 'pending_receipt'/);
      assert.deepEqual(params, ["0"]);
      return { rows: [{ id: "7", hash, amount: "1.00000000", destination: "0x" + "1".repeat(40), payload }] };
    } };
    const transport = {
      async hasTransaction(candidate) { assert.equal(candidate, hash); return alreadyKnown; },
      async send(value) { sent.push(value); }
    };
    assert.equal(await recoverSimulatedWithdrawals(pool, transport), null);
    assert.equal(sent.length, alreadyKnown ? 0 : 1);
    if (!alreadyKnown) assert.deepEqual(sent[0], { txHash: hash, amount: "1.00000000", destination: "0x" + "1".repeat(40), payload });
  });
}
