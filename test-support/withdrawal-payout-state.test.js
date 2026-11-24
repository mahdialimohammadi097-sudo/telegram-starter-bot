import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { confirmTestnetWithdrawal, submitSimulatedWithdrawal, recoverSimulatedWithdrawals, findUnrecoverableSimulatedWithdrawals } from "./simulated-withdrawal.js";

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
          if (sql === "BEGIN" || sql === "ROLLBACK") return { command: sql, rows: [], rowCount: 0 };
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
      return { rows: [{ id: "7", hash: "0x" + createHash("sha256").update("test").digest("hex"), amount: "1", destination: "0x" + "1".repeat(40), payload: Buffer.from("test") }] };
    } };
    const transport = { hasTransaction: async () => lookupResult, send: async () => { sent++; } };
    await assert.rejects(recoverSimulatedWithdrawals(pool, transport), /indeterminate transaction status/);
    assert.equal(sent, 0);
  });
}

for (const alreadyKnown of [true, false]) {
  test("recovery " + (alreadyKnown ? "skips" : "resends") + " a known-status synthetic transaction", async () => {
    const payload = Buffer.from("synthetic");
    const hash = "0x" + createHash("sha256").update(payload).digest("hex");
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

for (const payload of [null, undefined, Buffer.alloc(0), "not bytes"]) {
  test("submission rejects nonrecoverable payload before database write", async () => {
    let writes = 0;
    const pool = { async query() { writes++; throw new Error("unexpected database write"); } };
    await assert.rejects(
      submitSimulatedWithdrawal(pool, "7", "0x" + "a".repeat(64), async () => {}, payload),
      /requires a nonempty recovery payload/
    );
    assert.equal(writes, 0);
  });
}

test("legacy withdrawal diagnostic only reads incomplete pending submissions", async () => {
  let called = 0;
  const pool = { async query(sql, params) {
    called++;
    assert.match(sql, /simulation_payload IS NULL/);
    assert.match(sql, /octet_length\(simulation_payload\) = 0/);
    assert.match(sql, /status = 'pending_receipt'/);
    assert.deepEqual(params, [25]);
    return { rows: [{ id: "7", hash: "0x" + "a".repeat(64) }] };
  } };
  assert.deepEqual(await findUnrecoverableSimulatedWithdrawals(pool, 25), [{ id: "7", hash: "0x" + "a".repeat(64) }]);
  assert.equal(called, 1);
});

for (const invalid of [0, -1, 101, 1.5, "10"]) {
  test("legacy diagnostic rejects invalid page size without database access", async () => {
    const pool = { async query() { assert.fail("database must not be accessed"); } };
    await assert.rejects(findUnrecoverableSimulatedWithdrawals(pool, invalid), /Invalid diagnostic page size/);
  });
}

for (const corrupt of [Buffer.from("wrong"), Buffer.alloc(0), null]) {
  test("recovery refuses corrupted persisted payload before transport access", async () => {
    const payload = Buffer.from("original");
    const hash = "0x" + (await import("node:crypto")).createHash("sha256").update(payload).digest("hex");
    let calls = 0;
    const pool = { async query() { return { rows: [{ id: "7", hash, payload: corrupt, amount: "1", destination: "0x" + "1".repeat(40) }] }; } };
    const transport = { hasTransaction() { calls++; return false; }, send() { calls++; } };
    await assert.rejects(recoverSimulatedWithdrawals(pool, transport), /payload hash mismatch/);
    assert.equal(calls, 0);
  });
}
