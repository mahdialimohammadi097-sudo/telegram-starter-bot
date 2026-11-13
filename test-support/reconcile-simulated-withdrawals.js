export async function findWithdrawalDiscrepancies(client) {
  const { rows } = await client.query(`
    WITH expected AS (
      SELECT w.*, op.kind,
             op.kind = 'reserve' OR w.status = 'cancelled' AS required,
             CASE WHEN op.kind = 'reserve' THEN w.available_id ELSE w.held_id END AS debit_id,
             CASE WHEN op.kind = 'reserve' THEN w.held_id ELSE w.available_id END AS credit_id
      FROM simulation_withdrawals w
      CROSS JOIN (VALUES ('reserve'), ('release')) op(kind)
    ), actual AS (
      SELECT t.*, count(*) OVER (PARTITION BY reference_id, transaction_type) AS copies
      FROM ledger_transactions t
      WHERE transaction_type IN ('sim-withdraw-reserve', 'sim-withdraw-release')
    )
    SELECT w.id AS withdrawal_id, j.id AS journal_id,
           coalesce(w.kind, replace(j.transaction_type, 'sim-withdraw-', '')) AS operation
    FROM expected w FULL JOIN actual j
      ON j.reference_id = w.id::text AND j.transaction_type = 'sim-withdraw-' || w.kind
    WHERE w.id IS NULL OR w.required IS DISTINCT FROM (j.id IS NOT NULL)
       OR (w.kind = 'release' AND w.release_id IS DISTINCT FROM j.id)
       OR (j.id IS NOT NULL AND (
         j.status IS DISTINCT FROM 'posted' OR j.copies <> 1
         OR j.idempotency_key IS DISTINCT FROM j.transaction_type || ':' || w.id
         OR NOT EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.id = w.available_id
           AND a.user_id = w.user_id AND a.account_type = 'AVAILABLE' AND a.currency = 'USDT')
         OR NOT EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.id = w.held_id
           AND a.user_id = w.user_id AND a.account_type = 'WITHDRAWAL_HOLD' AND a.currency = 'USDT')
         OR (SELECT count(*) FROM ledger_entries WHERE transaction_id = j.id) <> 2
         OR EXISTS (
           SELECT * FROM (VALUES (w.debit_id, 'debit', w.amount), (w.credit_id, 'credit', w.amount))
             expected_entry(account_id, entry_type, amount)
           EXCEPT ALL
           SELECT account_id, entry_type, amount FROM ledger_entries
           WHERE transaction_id = j.id AND currency = 'USDT'
         )
       ))
    ORDER BY w.id, j.id, operation
  `);
  return rows;
}
