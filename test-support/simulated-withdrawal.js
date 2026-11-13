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
    // First-use setup shares the reservation transaction so a failed hold leaves no account behind.
    await client.query(
      `INSERT INTO ledger_accounts (user_id, account_code, account_type, currency)
       VALUES ($1, 'simulation:hold:' || $1::bigint::text, 'WITHDRAWAL_HOLD', 'USDT')
       ON CONFLICT (user_id, account_type, currency) DO NOTHING`, [userId]
    );
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
    return releaseReservation(client, request, null);
  });
}

async function releaseReservation(client, request, reviewerId) {
  const journal = await postMovement(client, request, "release", request.held_id, request.available_id);
  await client.query(
    "UPDATE simulation_withdrawals SET status = 'cancelled', release_id = $2, cancelled_by_reviewer = $3 WHERE id = $1",
    [request.id, journal.transactionId, reviewerId]
  );
  return journal.transactionId;
}

export async function cancelAsSimulationReviewer(pool, reviewerId, id) {
  return withLedgerTransaction(pool, client => releaseAsReviewer(client, reviewerId, id));
}

async function releaseAsReviewer(client, reviewerId, id) {
  const reviewer = await client.query(
    "SELECT user_id FROM simulation_reviewers WHERE user_id = $1 AND active FOR SHARE", [reviewerId]
  );
  if (!reviewer.rowCount) throw new Error("Unauthorized simulation reviewer");
  const { rows: [request] } = await client.query(
    "SELECT * FROM simulation_withdrawals WHERE id = $1 FOR UPDATE", [id]
  );
  if (!request) throw new Error("Unknown withdrawal");
  if (request.status === "cancelled") return request.release_id;
  if (request.status !== "reserved") throw new Error("Withdrawal cannot be cancelled");
  return releaseReservation(client, request, reviewerId);
}

export async function listReservedWithdrawals(pool, userId) {
  const { rows } = await pool.query(
    `SELECT id, amount FROM simulation_withdrawals
     WHERE user_id = $1 AND status = 'reserved' ORDER BY id LIMIT 10`, [userId]
  );
  return rows;
}

export function simulationWithdrawalReview(pool) {
  return {
    async list(telegramId, afterId) {
      const { rows } = await pool.query(
        `SELECT w.id, trim_scale(w.amount)::text AS amount FROM simulation_withdrawals w
         WHERE w.status = 'reserved' AND w.id > $2 AND EXISTS (
           SELECT 1 FROM simulation_reviewers r JOIN users u ON u.id = r.user_id
           WHERE r.active AND u.telegram_id = $1 AND u.status = 'active'
         ) ORDER BY w.id LIMIT 11`, [telegramId, afterId]
      );
      const holds = rows.slice(0, 10);
      return { holds, next: rows.length > 10 ? holds[9].id : null };
    },
    async inspect(telegramId, id) {
      const { rows } = await pool.query(
        `SELECT trim_scale(w.amount)::text AS amount, w.status, w.cancelled_by_reviewer,
                j.id AS journal_id, j.created_at AS released_at
         FROM simulation_withdrawals w
         LEFT JOIN ledger_transactions j ON j.id = w.release_id AND j.status = 'posted'
           AND j.transaction_type = 'sim-withdraw-release' AND j.reference_id = w.id::text
         WHERE w.id = $1 AND EXISTS (
           SELECT 1 FROM simulation_reviewers r JOIN users u ON u.id = r.user_id
           WHERE r.active AND u.telegram_id = $2 AND u.status = 'active'
         )`, [id, telegramId]
      );
      return rows[0];
    },
    async release(telegramId, id) {
      return withLedgerTransaction(pool, async client => {
        const { rows: [user] } = await client.query(
          "SELECT id FROM users WHERE telegram_id = $1 AND status = 'active' FOR SHARE", [telegramId]
        );
        if (!user) throw new Error("Unauthorized simulation reviewer");
        return releaseAsReviewer(client, user.id, id);
      });
    }
  };
}
