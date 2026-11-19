import test from "node:test";
import assert from "node:assert/strict";
import { confirmTestnetWithdrawal } from "./simulated-withdrawal.js";

test("receipt confirmation refuses a reserved withdrawal before reading external receipt", async () => {
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
          if (sql.includes("FROM simulation_withdrawals")) {
            return { rows: [{ id: "7", status: "reserved", destination: "0x1111111111111111111111111111111111111111", amount: "1.00000000" }], rowCount: 1 };
          }
          throw new Error("unexpected database query");
        },
        release() {}
      };
    }
  };
  await assert.rejects(
    confirmTestnetWithdrawal(pool, "7", {}, { txHash: "0x" + "a".repeat(64) }, { accountId: "1", sender: "0x2222222222222222222222222222222222222222" }),
    /must be submitted before receipt confirmation/
  );
});
