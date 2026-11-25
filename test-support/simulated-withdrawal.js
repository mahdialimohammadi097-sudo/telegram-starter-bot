import { createHash } from "node:crypto";
import { readTestnetWithdrawalReceipt } from "./bsc-testnet-receipt.js";
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

// Only certify a terminal replay if its original immutable journal matches.
// Never post a missing terminal journal or silently adopt a detached journal.
async function verifyMovementIdentity(client, request, operation, pointer, replay) {
  const type = "sim-withdraw-" + operation;
  const key = type + ":" + request.id;
  const prior = await client.query(
    `SELECT id, status, transaction_type, reference_id, idempotency_key
     FROM ledger_transactions
     WHERE idempotency_key = $1 OR (transaction_type = $2 AND reference_id = $3)
     ORDER BY id FOR UPDATE`, [key, type, String(request.id)]
  );
  if (replay) {
    const j = prior.rows[0];
    if (pointer == null || prior.rowCount !== 1 || j.status !== "posted" ||
        j.transaction_type !== type || j.reference_id !== String(request.id) ||
        j.idempotency_key !== key || String(j.id) !== String(pointer)) {
      throw new Error("Withdrawal journal mismatch; reconciliation required");
    }
  } else if (pointer != null || prior.rowCount !== 0) {
    throw new Error("Detached withdrawal journal; reconciliation required");
  }
}

export async function reserveWithdrawal(pool, userId, key, amount, destination = null) {
  if (typeof key !== "string" || !key.trim()) throw new Error("Missing request key");
  if (toUsdtUnitsExact(amount) <= 0n) throw new Error("Withdrawal must be positive");
  if (destination !== null && (!/^0x[0-9a-f]{40}$/i.test(destination) || /^0x0{40}$/i.test(destination))) {
    throw new Error("Invalid withdrawal destination");
  }
  destination = destination?.toLowerCase() ?? null;
  const normalized = formatUsdt(amount);
  return withLedgerTransaction(pool, async client => {
    const owner = await client.query("SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE", [userId]);
    if (!owner.rowCount) throw new Error("Unknown user");
    const prior = await client.query(
      "SELECT id, amount, status, destination, available_id, held_id FROM simulation_withdrawals WHERE user_id = $1 AND request_key = $2 FOR UPDATE", [userId, key]
    );
    if (prior.rowCount) {
      if (formatUsdt(prior.rows[0].amount) !== normalized) throw new Error("Request amount mismatch");
      const request = prior.rows[0];
      if (request.destination !== destination) throw new Error("Withdrawal destination mismatch");
      const type = "sim-withdraw-reserve";
      const original = await client.query(
        `SELECT id FROM ledger_transactions WHERE transaction_type = $1 AND reference_id = $2
         AND idempotency_key = $3 AND status = 'posted' FOR UPDATE`,
        [type, String(request.id), type + ":" + request.id]
      );
      await verifyMovementIdentity(client, request, "reserve", original.rows[0]?.id, true);
      const journal = await postMovement(client, request, "reserve", request.available_id, request.held_id);
      if (!journal.idempotent || journal.transactionId !== String(original.rows[0].id)) throw new Error("Withdrawal reservation replay mismatch");
      return { id: request.id, amount: request.amount, status: request.status };
    }
    // First-use setup shares the reservation transaction so a failed hold leaves no account behind.
    await client.query(
      `INSERT INTO ledger_accounts (user_id, account_code, account_type, currency)
       VALUES ($1, 'simulation:hold:' || $1::bigint::text, 'WITHDRAWAL_HOLD', 'USDT')
       ON CONFLICT (user_id, account_type, currency) DO NOTHING`, [userId]
    );
    const result = await client.query(
      `INSERT INTO simulation_withdrawals (user_id, request_key, amount, available_id, held_id, destination)
       SELECT a.user_id, $2, $3, a.id, h.id, $4 FROM ledger_accounts a JOIN ledger_accounts h ON h.user_id = a.user_id
       WHERE a.user_id = $1 AND a.currency = 'USDT' AND h.currency = 'USDT'
         AND a.account_type = 'AVAILABLE' AND h.account_type = 'WITHDRAWAL_HOLD'
       RETURNING id, amount, status, available_id, held_id`, [userId, key, normalized, destination]
    );
    if (!result.rowCount) throw new Error("Incomplete withdrawal wallet");
    const request = result.rows[0];
    await verifyMovementIdentity(client, request, "reserve", null, false);
    const journal = await postMovement(client, request, "reserve", request.available_id, request.held_id);
    if (journal.idempotent) throw new Error("Detached withdrawal reservation; reconciliation required");
    return { id: request.id, amount: request.amount, status: request.status };
  });
}

export async function cancelWithdrawal(pool, userId, id) {
  return withLedgerTransaction(pool, async client => {
    const { rows: [request] } = await client.query(
      "SELECT * FROM simulation_withdrawals WHERE id = $1 AND user_id = $2 FOR UPDATE", [id, userId]
    );
    if (!request) throw new Error("Unknown withdrawal");
    return releaseReservation(client, request, null);
  });
}

async function releaseReservation(client, request, reviewerId) {
  const replay = request.status === "cancelled";
  if (!replay && request.status !== "reserved") throw new Error("Withdrawal cannot be cancelled");
  await verifyMovementIdentity(client, request, "release", request.release_id, replay);
  const journal = await postMovement(client, request, "release", request.held_id, request.available_id);
  if (replay) {
    if (!journal.idempotent || journal.transactionId !== String(request.release_id)) throw new Error("Withdrawal release replay mismatch");
    return journal.transactionId;
  }
  if (journal.idempotent) throw new Error("Detached withdrawal journal; reconciliation required");
  const updated = await client.query(
    "UPDATE simulation_withdrawals SET status = 'cancelled', release_id = $2, cancelled_by_reviewer = $3 WHERE id = $1 AND status = 'reserved' AND release_id IS NULL",
    [request.id, journal.transactionId, reviewerId]
  );
  if (updated.rowCount !== 1) throw new Error("Withdrawal release transition unconfirmed");
  return journal.transactionId;
}

export async function cancelAsSimulationReviewer(pool, reviewerId, id) {
  return withLedgerTransaction(pool, client => releaseAsReviewer(client, reviewerId, id));
}

async function releaseAsReviewer(client, reviewerId, id) {
  const reviewer = await client.query(
    `SELECT r.user_id FROM simulation_reviewers r
     JOIN users u ON u.id = r.user_id
     WHERE r.user_id = $1 AND r.active AND u.status = 'active'
     FOR SHARE OF r, u`, [reviewerId]
  );
  if (!reviewer.rowCount) throw new Error("Unauthorized simulation reviewer");
  const { rows: [request] } = await client.query(
    "SELECT * FROM simulation_withdrawals WHERE id = $1 FOR UPDATE", [id]
  );
  if (!request) throw new Error("Unknown withdrawal");
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

// The offline caller supplies a prepared transaction hash and a fake transport.
// Commit the claim before submission: an ambiguous response can only be reconciled by hash.
export async function submitSimulatedWithdrawal(pool, id, txHash, send, payload = null) {
  // Reject invalid transports before persisting an irreversible submission claim.
  if (typeof send !== "function") throw new Error("Simulation transport sender required");
  // Every persisted submission must be replayable after a crash. A null payload
  // would be excluded from recovery and leave a pending receipt indefinitely.
  if (!Buffer.isBuffer(payload) || payload.length === 0) {
    throw new Error("Simulation submission requires a nonempty recovery payload");
  }
  if (typeof txHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(txHash)) throw new Error("Invalid transaction hash");
  const hash = txHash.toLowerCase();
  // Synthetic transport identity only. There is no chain signer in this harness.
  if ("0x" + createHash("sha256").update(payload).digest("hex") !== hash) {
    throw new Error("Simulation payload hash mismatch");
  }
  const claim = await pool.query(
    `UPDATE simulation_withdrawals SET status = 'pending_receipt', submitted_hash = $2, simulation_payload = $3
     WHERE id = $1 AND destination IS NOT NULL AND status = 'reserved'
     RETURNING amount, destination, simulation_payload`, [id, hash, payload]
  );
  if (claim.rowCount) {
    await send({ txHash: hash, amount: claim.rows[0].amount, destination: claim.rows[0].destination, payload: claim.rows[0].simulation_payload });
  } else {
    const { rows: [existing] } = await pool.query(
      "SELECT submitted_hash FROM simulation_withdrawals WHERE id = $1", [id]
    );
    if (existing?.submitted_hash !== hash) throw new Error("Withdrawal submission mismatch");
  }
  return hash;
}

// After a restart, process a bounded page. The transport must deduplicate identical
// payloads by hash, including if lookup lags or a previous submit lost its reply.
export async function recoverSimulatedWithdrawals(pool, transport, afterId = "0") {
  if (!transport || typeof transport.hasTransaction !== "function" || typeof transport.send !== "function") {
    throw new Error("Simulation recovery requires a queryable, send-capable transport");
  }
  const { rows } = await pool.query(
    `SELECT id, submitted_hash AS hash, amount, destination, simulation_payload AS payload
     FROM simulation_withdrawals WHERE status = 'pending_receipt' AND simulation_payload IS NOT NULL
       AND octet_length(simulation_payload) > 0
       AND id > $1 ORDER BY id LIMIT 50`, [afterId]
  );
  for (const request of rows) {
    // Never replay a persisted payload whose identity no longer matches its claim.
    if (!Buffer.isBuffer(request.payload) || request.payload.length === 0 ||
        typeof request.hash !== "string" ||
        "0x" + createHash("sha256").update(request.payload).digest("hex") !== request.hash.toLowerCase()) {
      throw new Error("Simulation recovery payload hash mismatch");
    }
    const known = await transport.hasTransaction(request.hash);
    if (typeof known !== "boolean") {
      throw new Error("Simulation transport returned an indeterminate transaction status");
    }
    if (known === false) {
      await transport.send({ txHash: request.hash, amount: request.amount, destination: request.destination, payload: request.payload });
    }
  }
  return rows.length === 50 ? rows[49].id : null;
}

export async function confirmTestnetWithdrawal(pool, id, observation, expected, treasury) {
  return withLedgerTransaction(pool, async client => {
    const { rows: [request] } = await client.query(
      "SELECT * FROM simulation_withdrawals WHERE id = $1 FOR UPDATE", [id]
    );
    if (!request?.destination || request.status === "cancelled") throw new Error("No payable withdrawal");
    if (request.status !== "pending_receipt" && request.status !== "paid") {
      throw new Error("Withdrawal must be submitted before receipt confirmation");
    }
    if (!request.submitted_hash) throw new Error("Withdrawal submission hash missing");
    const { event } = readTestnetWithdrawalReceipt(observation, expected, {
      sender: treasury.sender, recipient: request.destination, amount: request.amount
    });
    if (request.submitted_hash && request.submitted_hash !== expected.txHash.toLowerCase()) throw new Error("Withdrawal transaction mismatch");
    const replay = request.status === "paid";
    if (replay && (request.payout_event !== event || String(request.clearing_id) !== String(treasury.accountId))) throw new Error("Payout mismatch");
    await verifyMovementIdentity(client, request, "payout", request.payout_id, replay);
    const clearing = await client.query(
      "SELECT id FROM ledger_accounts WHERE id = $1 AND account_type = 'CLEARING' AND currency = 'USDT' AND user_id IS NULL FOR SHARE",
      [treasury.accountId]
    );
    if (!clearing.rowCount) throw new Error("Invalid payout clearing account");
    const journal = await postMovement(client, request, "payout", request.held_id, treasury.accountId);
    if (replay) {
      if (!journal.idempotent || journal.transactionId !== String(request.payout_id)) throw new Error("Withdrawal payout replay mismatch");
      return journal.transactionId;
    }
    if (journal.idempotent) throw new Error("Detached withdrawal journal; reconciliation required");
    const updated = await client.query(
      "UPDATE simulation_withdrawals SET status = 'paid', payout_event = $2, payout_id = $3, clearing_id = $4, submitted_hash = $5 WHERE id = $1 AND status = 'pending_receipt' AND payout_id IS NULL AND submitted_hash = $5",
      [id, event, journal.transactionId, treasury.accountId, expected.txHash.toLowerCase()]
    );
    if (updated.rowCount !== 1) throw new Error("Withdrawal payout transition unconfirmed");
    return journal.transactionId;
  });
}

// Read-only diagnostic for legacy submissions that cannot be safely replayed.
// Operators must reconcile these manually; never fabricate a missing payload.
export async function findUnrecoverableSimulatedWithdrawals(pool, limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Invalid diagnostic page size");
  }
  const { rows } = await pool.query(
    `SELECT id, submitted_hash AS hash FROM simulation_withdrawals
     WHERE status = 'pending_receipt'
       AND (simulation_payload IS NULL OR octet_length(simulation_payload) = 0)
     ORDER BY id LIMIT $1`, [limit]
  );
  return rows;
}
