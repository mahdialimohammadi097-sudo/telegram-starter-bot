import test from "node:test";
import assert from "node:assert/strict";
import { confirmTestnetWithdrawal, submitSimulatedWithdrawal } from "./simulated-withdrawal.js";

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
