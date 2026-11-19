import test from "node:test";
import assert from "node:assert/strict";
import { confirmTestnetWithdrawal } from "./simulated-withdrawal.js";

for (const scenario of [
  { status: "reserved", submitted_hash: null, error: /must be submitted before receipt confirmation/ },
  { status: "pending_receipt", submitted_hash: null, error: /submission hash missing/ }
]) test("receipt confirmation rejects invalid submission state: " + scenario.status, async () => {
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
          if (sql.includes("FROM simulation_withdrawals")) {
            return { rows: [{ id: "7", status: scenario.status, submitted_hash: scenario.submitted_hash, destination: "0x1111111111111111111111111111111111111111", amount: "1.00000000" }], rowCount: 1 };
          }
          throw new Error("unexpected database query");
        },
        release() {}
      };
    }
  };
  await assert.rejects(
    confirmTestnetWithdrawal(pool, "7", {}, { txHash: "0x" + "a".repeat(64) }, { accountId: "1", sender: "0x2222222222222222222222222222222222222222" }),
    scenario.error
  );
});
