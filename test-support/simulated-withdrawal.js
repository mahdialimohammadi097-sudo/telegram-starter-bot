import { toUsdtUnitsExact, formatUsdt } from "../src/ledger-safety.js";
import { postJournalInTransaction, withLedgerTransaction } from "../src/ledger-posting.js";

async function postMovement(client, request, operation, debit, credit) {
  return postJournalInTransaction(client, {
    transactionType: "sim-withdraw-" + operation, referenceId: request.id,
    idempotencyKey: "sim-withdraw-" + operation + ":" + request.id,
    entries: [
      { account_id: debit, entry_type: "debit", amount: request.amount, currency: "USDT" },
      { account_id: credit, entry_type: "credit", amount: request.amount, currency: "USDT" }
    ]
  });
}

export async function reserveWithdrawal(pool, userId, key, amount) {
  if (typeof key !== "string" || !key.trim()) throw new Error("Missing request key");
  if (toUsdtUnitsExact(amount) <= 0n) throw new Error("Withdrawal must be positive");
  const normalized = formatUsdt(amount);
  return withLedgerTransaction(pool, async client => {
    const owner = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!owner.rowCount) throw new Error("Unknown user");
    const prior = await client.query(
      "SELECT id, amount, status FROM simulation_withdrawals WHERE user_id = $1 AND request_key = $2", [userId, key]
    );
    if (prior.rowCount) {
      if (formatUsdt(prior.rows[0].amount) !== normalized) throw new Error("Request amount mismatch");
      return prior.rows[0];
    }
    const result = await client.query(
      `INSERT INTO simulation_withdrawals (user_id, request_key, amount, available_id, held_id)
       SELECT a.user_id, $2, $3, a.id, h.id FROM ledger_accounts a JOIN ledger_accounts h ON h.user_id = a.user_id
       WHERE a.user_id = $1 AND a.currency = 'USDT' AND h.currency = 'USDT'
         AND a.account_type = 'AVAILABLE' AND h.account_type = 'WITHDRAWAL_HOLD'
       RETURNING id, amount, status, available_id, held_id`, [userId, key, normalized]
    );
    if (!result.rowCount) throw new Error("Incomplete withdrawal wallet");
    const request = result.rows[0];
    await postMovement(client, request, "reserve", request.available_id, request.held_id);
    return { id: request.id, amount: request.amount, status: request.status };
  });
}

export async function cancelWithdrawal(pool, userId, id) {
  return withLedgerTransaction(pool, async client => {
    const { rows: [request] } = await client.query(
      "SELECT * FROM simulation_withdrawals WHERE id = $1 AND user_id = $2 FOR UPDATE", [id, userId]
    );
    if (!request) throw new Error("Unknown withdrawal");
    if (request.status === "cancelled") return request.release_id;
    if (request.status !== "reserved") throw new Error("Withdrawal cannot be cancelled");
    const journal = await postMovement(client, request, "release", request.held_id, request.available_id);
    await client.query("UPDATE simulation_withdrawals SET status = 'cancelled', release_id = $2 WHERE id = $1",
      [request.id, journal.transactionId]);
    return journal.transactionId;
  });
}
