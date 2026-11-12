import { previewSettlement } from "../src/plan-preview.js";
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
