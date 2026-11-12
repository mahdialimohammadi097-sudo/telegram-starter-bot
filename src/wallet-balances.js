export async function getWalletBalances(pool, userId) {
  const result = await pool.query(
    `SELECT
       la.account_type,
       COALESCE(
         SUM(
           CASE
             WHEN le.entry_type = 'credit' THEN le.amount
             WHEN le.entry_type = 'debit' THEN -le.amount
             ELSE 0
           END
         ), 0
       ) AS balance
     FROM ledger_accounts la
     LEFT JOIN ledger_entries le
       ON le.account_id = la.id
      AND le.transaction_id IN (
        SELECT id
        FROM ledger_transactions
        WHERE status = 'posted'
      )
     WHERE la.user_id = $1
       AND la.currency = 'USDT'
     GROUP BY la.account_type
     ORDER BY la.account_type`,
    [userId]
  );

  const balances = {
    AVAILABLE: null,
    INVESTED: null,
    PROFIT: null
  };

  for (const row of result.rows) {
    if (Object.hasOwn(balances, row.account_type)) {
      balances[row.account_type] = row.balance;
    }
  }

  if (Object.values(balances).some(value => value === null)) {
    throw new Error("Wallet accounts are incomplete");
  }

  return balances;
}

export async function getRecentWalletEntries(pool, userId) {
  const result = await pool.query(
    `SELECT t.created_at, a.account_type, e.entry_type, e.amount
     FROM ledger_accounts a
     JOIN ledger_entries e ON e.account_id = a.id AND e.currency = a.currency
     JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE a.user_id = $1 AND a.currency = 'USDT' AND t.status = 'posted'
       AND a.account_type IN ('AVAILABLE', 'INVESTED', 'PROFIT')
     ORDER BY t.created_at DESC, t.id DESC, e.id DESC
     LIMIT 10`, [userId]
  );
  return result.rows;
}
