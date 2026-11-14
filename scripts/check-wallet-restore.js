import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { postLedgerTransaction } from "../src/ledger-posting.js";
import { formatUsdt } from "../src/ledger-safety.js";
import { getSimulationReceipt, getWalletBalances } from "../src/wallet-balances.js";
import { cancelWithdrawal, reserveWithdrawal } from "../test-support/simulated-withdrawal.js";
import { findWithdrawalDiscrepancies } from "../test-support/reconcile-simulated-withdrawals.js";
import { createSimulationWithdrawalTables } from "../test-support/withdrawal-schema.js";

const mode = process.argv[2];
assert.ok(["seed", "verify"].includes(mode));
const database = mode === "seed" ? "wallet_drill_source" : "wallet_drill_restored";
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, "localhost");
url.pathname = "/" + database;
const pool = new pg.Pool({ connectionString: url.href });
try {
  if (mode === "seed") {
    await pool.query(await readFile(new URL("../test/fixtures/ledger-contract.sql", import.meta.url), "utf8"));
    await createSimulationWithdrawalTables(pool);
    await pool.query(`
      ALTER TABLE users ADD COLUMN telegram_id bigint, ADD COLUMN status text;
      INSERT INTO users VALUES (1, 7001, 'active');
      INSERT INTO ledger_accounts (user_id, account_code, account_type)
      VALUES (1,'available','AVAILABLE'), (1,'invested','INVESTED'), (1,'profit','PROFIT'), (null,'clearing','CLEARING')
    `);
    const { rows } = await pool.query("SELECT id, account_code FROM ledger_accounts");
    const accounts = Object.fromEntries(rows.map(row => [row.account_code, row.id]));
    await postLedgerTransaction({ pool, transactionType: "simulated-deposit", referenceId: "1", idempotencyKey: "drill-deposit",
      entries: [
        { account_id: accounts.clearing, entry_type: "debit", amount: "25", currency: "USDT" },
        { account_id: accounts.available, entry_type: "credit", amount: "25", currency: "USDT" }
      ]
    });
    const closed = await reserveWithdrawal(pool, 1, "closed", "5");
    await cancelWithdrawal(pool, 1, closed.id);
    await reserveWithdrawal(pool, 1, "open", "7.25");
  }
  const { rows: requests } = await pool.query(
    "SELECT id, request_key, status, release_id FROM simulation_withdrawals ORDER BY id"
  );
  assert.deepEqual(requests.map(row => [row.request_key, row.status]), [["closed", "cancelled"], ["open", "reserved"]]);
  const balances = await getWalletBalances(pool, 1);
  assert.equal(formatUsdt(balances.AVAILABLE), "17.75000000");
  assert.equal(formatUsdt(balances.WITHDRAWAL_HOLD), "7.25000000");
  const receipt = await getSimulationReceipt(pool, 7001, requests[0].release_id);
  assert.equal(receipt.reference_id, requests[0].id);
  assert.equal(formatUsdt(receipt.amount), "5.00000000");
  assert.deepEqual(await findWithdrawalDiscrepancies(pool), []);
  // Compare the application-visible snapshot across databases before replaying operations.
  console.log(JSON.stringify({ requests, balances, receipt }));
  if (mode === "verify") {
    const posted = "SELECT id FROM ledger_transactions WHERE idempotency_key = 'drill-deposit'";
    await assert.rejects(
      pool.query("UPDATE ledger_transactions SET description = 'restore probe' WHERE id IN (" + posted + ")"),
      { code: "P0001", message: /posted transactions are immutable/i }
    );
    await assert.rejects(
      pool.query("DELETE FROM ledger_entries WHERE transaction_id IN (" + posted + ")"),
      { code: "P0001", message: /entries of posted transactions cannot be changed/i }
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [journal] } = await client.query(
        "INSERT INTO ledger_transactions(transaction_type) VALUES ('restore-probe') RETURNING id"
      );
      await client.query(`INSERT INTO ledger_entries(transaction_id, account_id, entry_type, amount)
        SELECT $1, id, 'credit', 1 FROM ledger_accounts WHERE account_code='available'`, [journal.id]);
      await client.query("UPDATE ledger_transactions SET status='posted' WHERE id=$1", [journal.id]);
      await assert.rejects(client.query("COMMIT"), { code: "P0001", message: /not balanced/i });
      const probe = await client.query("SELECT id FROM ledger_transactions WHERE id=$1", [journal.id]);
      assert.equal(probe.rowCount, 0);
    } finally {
      try { await client.query("ROLLBACK"); }
      finally { client.release(); }
    }
    console.error("Restored ledger rejected posted mutations and rolled back an unbalanced commit.");
    assert.equal(await cancelWithdrawal(pool, 1, requests[0].id), requests[0].release_id);
    assert.equal((await reserveWithdrawal(pool, 1, "open", "7.25")).id, requests[1].id);
    await cancelWithdrawal(pool, 1, requests[1].id);
    const recovered = await getWalletBalances(pool, 1);
    assert.equal(formatUsdt(recovered.AVAILABLE), "25.00000000");
    assert.equal(formatUsdt(recovered.WITHDRAWAL_HOLD), "0.00000000");
    assert.deepEqual(await findWithdrawalDiscrepancies(pool), []);
  }
} finally {
  await pool.end();
}
