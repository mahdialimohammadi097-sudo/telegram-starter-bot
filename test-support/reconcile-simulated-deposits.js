// Read-only comparison of approved claims and posted simulated deposit journals.
// Uses the known clearing account and independently assigned AVAILABLE accounts.
export async function findSimulationDiscrepancies(pool, clearingAccountId) {
  const result = await pool.query(
    `WITH approved AS (
       SELECT d.id, d.amount, d.transfer_event, a.id AS wallet_id
       FROM deposit_requests d
       LEFT JOIN ledger_accounts a ON a.user_id = d.user_id
         AND a.account_type = 'AVAILABLE' AND a.currency = 'USDT'
       WHERE d.status = 'approved'
     ), posted AS (
       SELECT id, reference_id, idempotency_key
       FROM ledger_transactions WHERE transaction_type = 'simulated-deposit' AND status = 'posted'
     )
     SELECT a.id AS request_id, j.id AS journal_id
     FROM approved a FULL JOIN posted j ON j.reference_id = a.id::text
     LEFT JOIN ledger_entries e ON e.transaction_id = j.id
     GROUP BY a.id, a.amount, a.transfer_event, a.wallet_id, j.id, j.idempotency_key
     HAVING a.id IS NULL OR j.id IS NULL
        OR j.idempotency_key IS DISTINCT FROM 'simulated-deposit:' || a.transfer_event
        OR count(e.id) <> 2
        OR count(*) FILTER (WHERE e.account_id = a.wallet_id AND e.entry_type = 'credit'
                             AND e.currency = 'USDT' AND e.amount = a.amount) <> 1
        OR count(*) FILTER (WHERE e.account_id = $1 AND e.entry_type = 'debit'
                             AND e.currency = 'USDT' AND e.amount = a.amount) <> 1
     ORDER BY a.id, j.id`, [clearingAccountId]
  );
  return result.rows;
}
