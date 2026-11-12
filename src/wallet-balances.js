export class IncompleteWalletError extends Error {
  constructor() {
    super("Wallet accounts are incomplete");
  }
}

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
      AND le.currency = la.currency
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
    if (Object.hasOwn(balances, row.account_type) || row.account_type === "WITHDRAWAL_HOLD") {
      balances[row.account_type] = row.balance;
    }
  }

  if (Object.values(balances).some(value => value === null)) {
    throw new IncompleteWalletError();
  }

  return balances;
}

export async function getRecentWalletEntries(pool, userId) {
  const page = await getWalletHistoryPage(pool, userId);
  return page.entries;
}

export async function getWalletHistoryPage(pool, userId, beforeId = null) {
  const result = await pool.query(
    `SELECT t.created_at, t.id AS journal_id, e.id AS entry_id, t.transaction_type, a.account_type, e.entry_type, e.amount
     FROM ledger_accounts a
     JOIN ledger_entries e ON e.account_id = a.id AND e.currency = a.currency
     JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE a.user_id = $1 AND a.currency = 'USDT' AND t.status = 'posted'
       AND a.account_type IN ('AVAILABLE', 'INVESTED', 'PROFIT', 'WITHDRAWAL_HOLD')
       AND ($2::bigint IS NULL OR (t.created_at, t.id, e.id) < (
         SELECT ct.created_at, ct.id, ce.id
         FROM ledger_entries ce JOIN ledger_accounts ca ON ca.id = ce.account_id
         JOIN ledger_transactions ct ON ct.id = ce.transaction_id
         WHERE ce.id = $2 AND ca.user_id = $1 AND ca.currency = 'USDT'
           AND ce.currency = ca.currency AND ct.status = 'posted'
           AND ca.account_type IN ('AVAILABLE', 'INVESTED', 'PROFIT', 'WITHDRAWAL_HOLD')
       ))
     ORDER BY t.created_at DESC, t.id DESC, e.id DESC
     LIMIT 11`, [userId, beforeId]
  );
  const entries = result.rows.slice(0, 10);
  return { entries, next: result.rows.length > 10 ? entries[9].entry_id : null };
}

export async function getSimulatedInvestmentActivity(pool, userId) {
  const result = await pool.query(
    `SELECT t.transaction_type, t.reference_id, t.created_at, e.amount AS principal,
            (SELECT sum(p.amount) FROM ledger_entries p
             JOIN ledger_accounts dest ON dest.id = p.account_id
             WHERE p.transaction_id = t.id AND dest.user_id = a.user_id
               AND dest.account_type = 'AVAILABLE' AND dest.currency = 'USDT'
               AND p.currency = 'USDT' AND p.entry_type = 'credit') AS payout
     FROM ledger_accounts a
     JOIN ledger_entries e ON e.account_id = a.id AND e.currency = a.currency
     JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE a.user_id = $1 AND a.account_type = 'INVESTED' AND a.currency = 'USDT'
       AND t.status = 'posted'
       AND ((t.transaction_type = 'simulated-investment-open' AND e.entry_type = 'credit')
         OR (t.transaction_type = 'simulated-investment-settle' AND e.entry_type = 'debit'))
     ORDER BY t.created_at DESC, t.id DESC, e.id DESC LIMIT 10`, [userId]
  );
  return result.rows;
}

export async function getDailySimulatedProfits(pool, userId) {
  const { rows } = await pool.query(
    `WITH settlements AS (
       SELECT t.id, (t.created_at AT TIME ZONE 'UTC')::date AS day,
              sum(e.amount) FILTER (WHERE a.account_type = 'AVAILABLE' AND e.entry_type = 'credit') AS payout,
              sum(e.amount) FILTER (WHERE a.account_type = 'INVESTED' AND e.entry_type = 'debit') AS principal
       FROM ledger_accounts a
       JOIN ledger_entries e ON e.account_id = a.id AND e.currency = a.currency
       JOIN ledger_transactions t ON t.id = e.transaction_id
       WHERE a.user_id = $1 AND a.currency = 'USDT' AND a.account_type IN ('AVAILABLE', 'INVESTED')
         AND t.transaction_type = 'simulated-investment-settle' AND t.status = 'posted'
       GROUP BY t.id, t.created_at
     )
     SELECT to_char(day, 'YYYY-MM-DD') AS day, count(*)::int AS settlements,
            sum(payout - principal) AS net_profit
     FROM settlements WHERE principal IS NOT NULL AND payout IS NOT NULL
     GROUP BY day ORDER BY day DESC LIMIT 10`, [userId]
  );
  return rows;
}

export async function getSimulatedTransferActivity(pool, userId, section) {
  const deposit = section === "Deposit";
  if (!deposit && section !== "Withdraw") throw new TypeError("Unknown transfer section");
  const types = deposit ? ["simulated-deposit"] : ["sim-withdraw-reserve", "sim-withdraw-release"];
  const { rows } = await pool.query(
    `SELECT t.id AS journal_id, t.created_at, t.transaction_type, t.reference_id, e.amount
     FROM ledger_accounts a
     JOIN ledger_entries e ON e.account_id = a.id AND e.currency = a.currency
     JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE a.user_id = $1 AND a.currency = 'USDT' AND a.account_type = $2
       AND t.transaction_type = ANY($3::text[]) AND t.status = 'posted'
       AND e.entry_type = CASE WHEN t.transaction_type = 'sim-withdraw-release' THEN 'debit' ELSE 'credit' END
     ORDER BY t.created_at DESC, t.id DESC, e.id DESC LIMIT 10`,
    [userId, deposit ? "AVAILABLE" : "WITHDRAWAL_HOLD", types]
  );
  return rows;
}

export async function getSimulationReceipt(pool, telegramId, journalId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.created_at, t.transaction_type, t.reference_id, e.amount
     FROM users u
     JOIN ledger_accounts a ON a.user_id = u.id AND a.currency = 'USDT'
     JOIN ledger_entries e ON e.account_id = a.id AND e.currency = a.currency
     JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE u.telegram_id = $1 AND u.status = 'active' AND t.id = $2 AND t.status = 'posted'
       AND ((t.transaction_type = 'simulated-deposit' AND a.account_type = 'AVAILABLE' AND e.entry_type = 'credit')
         OR (t.transaction_type = 'sim-withdraw-reserve' AND a.account_type = 'WITHDRAWAL_HOLD' AND e.entry_type = 'credit')
         OR (t.transaction_type = 'sim-withdraw-release' AND a.account_type = 'AVAILABLE' AND e.entry_type = 'credit'))
       AND (SELECT count(*) FROM ledger_entries WHERE transaction_id = t.id) = 2
       AND EXISTS (
         SELECT 1 FROM ledger_entries other JOIN ledger_accounts source ON source.id = other.account_id
         WHERE other.transaction_id = t.id AND other.entry_type = 'debit' AND other.amount = e.amount
           AND other.currency = 'USDT' AND source.currency = 'USDT'
           AND ((t.transaction_type = 'simulated-deposit' AND source.user_id IS NULL AND source.account_type = 'CLEARING')
             OR (t.transaction_type = 'sim-withdraw-reserve' AND source.user_id = u.id AND source.account_type = 'AVAILABLE')
             OR (t.transaction_type = 'sim-withdraw-release' AND source.user_id = u.id AND source.account_type = 'WITHDRAWAL_HOLD'))
       )`, [telegramId, journalId]
  );
  return rows[0];
}
