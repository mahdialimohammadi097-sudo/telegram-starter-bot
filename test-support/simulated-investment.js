import { previewSettlement, settlementAmounts } from "../src/plan-preview.js";
import { withLedgerTransaction, postJournalInTransaction } from "../src/ledger-posting.js";

// A request record alone cannot certify that the opening journal committed.
async function verifyOpeningJournal(client, userId, investmentId, amount, replay) {
  const type = "simulated-investment-open";
  const key = type + ":" + investmentId;
  const prior = await client.query(
    `SELECT id, transaction_type, reference_id, idempotency_key, status
     FROM ledger_transactions WHERE idempotency_key = $1 OR (transaction_type = $2 AND reference_id = $3)
     ORDER BY id FOR UPDATE`, [key, type, String(investmentId)]
  );
  if (replay) {
    const j = prior.rows[0];
    if (prior.rowCount !== 1 || j.status !== "posted" || j.transaction_type !== type ||
        j.reference_id !== String(investmentId) || j.idempotency_key !== key) {
      throw new Error("Investment opening journal mismatch; reconciliation required");
    }
  } else if (prior.rowCount !== 0) {
    throw new Error("Detached investment opening journal; reconciliation required");
  }
    const { rows } = await client.query(
      `SELECT account_type, id FROM ledger_accounts WHERE user_id = $1
       AND currency = 'USDT' AND account_type IN ('AVAILABLE','INVESTED')`, [userId]
    );
    const accounts = new Map(rows.map(row => [row.account_type, row.id]));
    if (accounts.size !== 2) throw new Error("Incomplete investment wallet");
    const journal = await postJournalInTransaction(client, {
      transactionType: "simulated-investment-open", referenceId: investmentId,
      idempotencyKey: "simulated-investment-open:" + investmentId,
      entries: [
        { account_id: accounts.get("AVAILABLE"), entry_type: "debit", amount: amount, currency: "USDT" },
        { account_id: accounts.get("INVESTED"), entry_type: "credit", amount: amount, currency: "USDT" }
      ]
    });
    if (journal.idempotent !== replay || (replay && journal.transactionId !== String(prior.rows[0].id))) {
      throw new Error("Investment opening replay mismatch; reconciliation required");
    }

}

export async function openSimulatedInvestment(pool, userId, requestId, selection) {
  const plan = previewSettlement(selection);
  if (!plan) throw new Error("Unsupported plan or amount");
  if (typeof requestId !== "string" || !requestId.trim()) throw new Error("Missing request ID");
  return withLedgerTransaction(pool, async client => {
    const user = await client.query("SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE", [userId]);
    if (!user.rowCount) throw new Error("Unknown user");
    const prior = await client.query(
      "SELECT id, plan, principal::text FROM simulation_investments WHERE user_id = $1 AND request_id = $2",
      [userId, requestId]
    );
    if (prior.rowCount) {
      const investment = prior.rows[0];
      if (investment.plan !== plan.name || investment.principal !== plan.amount) {
        throw new Error("Request already used for a different investment");
      }
      await verifyOpeningJournal(client, userId, investment.id, plan.amount, true);
      return investment.id;
    }
    const active = await client.query(
      "SELECT count(*)::int AS count FROM simulation_investments WHERE user_id = $1 AND status = 'active'", [userId]
    );
    if (active.rows[0].count >= 5) throw new Error("Five active investments already open");

    const { rows: [investment] } = await client.query(
      `INSERT INTO simulation_investments
        (user_id, request_id, plan, principal, profit_percent, fee_percent, matures_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + $7::int * interval '24 hours') RETURNING id`,
      [userId, requestId, plan.name, plan.amount, plan.profitPercent, plan.feePercent, plan.days]
    );
    await verifyOpeningJournal(client, userId, investment.id, plan.amount, false);
    return investment.id;
  });
}

export async function settleSimulatedInvestment(pool, userId, investmentId, reserveId, feeId) {
  return withLedgerTransaction(pool, async client => {
    // Take locks in the same order as opening so a freed slot is visible atomically.
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    return settleLockedInvestment(client, userId, investmentId, reserveId, feeId);
  });
}

export async function settleNextDueSimulation(pool, reserveId, feeId) {
  return withLedgerTransaction(pool, async client => {
    // Claim the owner first, matching the lock order used for manual settlement and opening.
    const { rows: [owner] } = await client.query(
      `SELECT u.id FROM simulation_investments i JOIN users u ON u.id = i.user_id
       WHERE i.status = 'active' AND i.matures_at <= now()
       ORDER BY i.matures_at, i.id LIMIT 1 FOR UPDATE OF u SKIP LOCKED`
    );
    if (!owner) return null;
    const { rows: [due] } = await client.query(
      `SELECT id FROM simulation_investments WHERE user_id = $1 AND status = 'active' AND matures_at <= now()
       ORDER BY matures_at, id LIMIT 1 FOR UPDATE`, [owner.id]
    );
    if (!due) return null;
    return settleLockedInvestment(client, owner.id, due.id, reserveId, feeId);
  });
}

async function settleLockedInvestment(client, userId, investmentId, reserveId, feeId) {
  const { rows: [investment] } = await client.query(
    `SELECT status, settlement_id, principal, profit_percent, fee_percent, matures_at <= now() AS mature
     FROM simulation_investments WHERE id = $1 AND user_id = $2 FOR UPDATE`, [investmentId, userId]
  );
  if (!investment) throw new Error("Unknown investment");
  const replay = investment.status === "settled";
  if (!replay && (investment.status !== "active" || !investment.mature)) throw new Error("Investment is not due");
  const key = "simulated-investment-settle:" + investmentId;
  // Never silently repair a detached journal or certify a corrupted terminal state.
  const prior = await client.query(
    `SELECT id, status, transaction_type, reference_id, idempotency_key
     FROM ledger_transactions
     WHERE idempotency_key = $1 OR (transaction_type = 'simulated-investment-settle' AND reference_id = $2)
     ORDER BY id FOR UPDATE`, [key, String(investmentId)]
  );
  if (replay) {
    const j = prior.rows[0];
    if (!investment.mature || investment.settlement_id == null || prior.rowCount !== 1 ||
        j.status !== "posted" || j.transaction_type !== "simulated-investment-settle" ||
        j.reference_id !== String(investmentId) || j.idempotency_key !== key ||
        String(j.id) !== String(investment.settlement_id)) {
      throw new Error("Investment settlement journal mismatch; reconciliation required");
    }
  } else if (investment.settlement_id != null || prior.rowCount !== 0) {
    throw new Error("Detached investment settlement journal; reconciliation required");
  }
  const { rows } = await client.query(
    `SELECT account_type, id FROM ledger_accounts WHERE user_id = $1 AND currency = 'USDT'
     AND account_type IN ('AVAILABLE', 'INVESTED')`, [userId]
  );
  const accounts = new Map(rows.map(row => [row.account_type, row.id]));
  if (accounts.size !== 2) throw new Error("Incomplete investment wallet");
  const { profit, fee, payout } = settlementAmounts(investment.principal, investment.profit_percent, investment.fee_percent);
  const sources = await client.query(
    `SELECT id FROM ledger_accounts WHERE user_id IS NULL AND currency = 'USDT'
     AND ((id = $1 AND account_type = 'AVAILABLE') OR (id = $2 AND account_type = 'CLEARING'))`, [reserveId, feeId]
  );
  if (sources.rowCount !== 2) throw new Error("Invalid simulation settlement accounts");
  const journal = await postJournalInTransaction(client, {
    transactionType: "simulated-investment-settle", referenceId: investmentId,
    idempotencyKey: key,
    entries: [
      { account_id: accounts.get("INVESTED"), entry_type: "debit", amount: String(investment.principal), currency: "USDT" },
      { account_id: reserveId, entry_type: "debit", amount: profit, currency: "USDT" },
      { account_id: accounts.get("AVAILABLE"), entry_type: "credit", amount: payout, currency: "USDT" },
      { account_id: feeId, entry_type: "credit", amount: fee, currency: "USDT" }
    ]
  });
  if (replay) {
    if (!journal.idempotent || journal.transactionId !== String(investment.settlement_id)) {
      throw new Error("Investment settlement replay mismatch; reconciliation required");
    }
    return journal.transactionId;
  }
  if (journal.idempotent) throw new Error("Detached investment settlement journal; reconciliation required");
  const updated = await client.query(
    "UPDATE simulation_investments SET status = 'settled', settlement_id = $2 WHERE id = $1 AND status = 'active' AND settlement_id IS NULL",
    [investmentId, journal.transactionId]
  );
  if (updated.rowCount !== 1) throw new Error("Investment settlement transition unconfirmed");
  return journal.transactionId;
}

export async function inspectDueSimulationQueue(pool, reserveId) {
  const { rows: [snapshot] } = await pool.query(
    `WITH due AS (
       SELECT id, matures_at, principal * profit_percent / 100::numeric AS required
       FROM simulation_investments WHERE status = 'active' AND matures_at <= now()
     ), first_due AS (
       SELECT id, required FROM due ORDER BY matures_at, id LIMIT 1
     ), reserve AS (
       SELECT a.id, coalesce(sum(CASE WHEN e.entry_type = 'credit' THEN e.amount ELSE -e.amount END)
         FILTER (WHERE t.status = 'posted'), 0) AS balance
       FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id AND e.currency = a.currency
       LEFT JOIN ledger_transactions t ON t.id = e.transaction_id
       WHERE a.id = $1 AND a.user_id IS NULL AND a.account_type = 'AVAILABLE' AND a.currency = 'USDT'
       GROUP BY a.id
     )
     SELECT (SELECT count(*)::int FROM due) AS due_count, f.id AS first_id,
            trim_scale(r.balance)::text AS reserve_balance,
            trim_scale(greatest(0, f.required - r.balance))::text AS first_shortfall,
            trim_scale(greatest(0, (SELECT sum(required) FROM due) - r.balance))::text AS total_shortfall
     FROM reserve r LEFT JOIN first_due f ON true`, [reserveId]
  );
  if (!snapshot) throw new Error("Invalid simulation reserve account");
  return snapshot;
}
