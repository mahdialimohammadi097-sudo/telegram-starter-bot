import { previewSettlement, settlementAmounts } from "../src/plan-preview.js";
import { withLedgerTransaction, postJournalInTransaction } from "../src/ledger-posting.js";

export async function openSimulatedInvestment(pool, userId, requestId, selection) {
  const plan = previewSettlement(selection);
  if (!plan) throw new Error("Unsupported plan or amount");
  if (typeof requestId !== "string" || !requestId.trim()) throw new Error("Missing request ID");
  return withLedgerTransaction(pool, async client => {
    const user = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
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
    const { rows } = await client.query(
      `SELECT account_type, id FROM ledger_accounts WHERE user_id = $1
       AND currency = 'USDT' AND account_type IN ('AVAILABLE','INVESTED')`, [userId]
    );
    const accounts = new Map(rows.map(row => [row.account_type, row.id]));
    if (accounts.size !== 2) throw new Error("Incomplete investment wallet");
    await postJournalInTransaction(client, {
      transactionType: "simulated-investment-open", referenceId: investment.id,
      idempotencyKey: "simulated-investment-open:" + investment.id,
      entries: [
        { account_id: accounts.get("AVAILABLE"), entry_type: "debit", amount: plan.amount, currency: "USDT" },
        { account_id: accounts.get("INVESTED"), entry_type: "credit", amount: plan.amount, currency: "USDT" }
      ]
    });
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
  if (investment.status === "settled") return investment.settlement_id;
  if (investment.status !== "active" || !investment.mature) throw new Error("Investment is not due");
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
    idempotencyKey: "simulated-investment-settle:" + investmentId,
    entries: [
      { account_id: accounts.get("INVESTED"), entry_type: "debit", amount: String(investment.principal), currency: "USDT" },
      { account_id: reserveId, entry_type: "debit", amount: profit, currency: "USDT" },
      { account_id: accounts.get("AVAILABLE"), entry_type: "credit", amount: payout, currency: "USDT" },
      { account_id: feeId, entry_type: "credit", amount: fee, currency: "USDT" }
    ]
  });
  await client.query(
    "UPDATE simulation_investments SET status = 'settled', settlement_id = $2 WHERE id = $1",
    [investmentId, journal.transactionId]
  );
  return journal.transactionId;
}
