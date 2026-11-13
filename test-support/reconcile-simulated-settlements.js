// Compare the four expected movements against the journal using PostgreSQL exact numeric arithmetic.
export async function findSettlementDiscrepancies(client, reserveId, feeId) {
  const { rows } = await client.query(
    `WITH settled AS (
       SELECT i.*, i.principal * (i.profit_percent / 100::numeric) AS profit,
              invested.id AS invested_id, available.id AS available_id
       FROM simulation_investments i
       LEFT JOIN ledger_accounts invested ON invested.user_id = i.user_id
         AND invested.currency = 'USDT' AND invested.account_type = 'INVESTED'
       LEFT JOIN ledger_accounts available ON available.user_id = i.user_id
         AND available.currency = 'USDT' AND available.account_type = 'AVAILABLE'
       WHERE i.status = 'settled' OR i.settlement_id IS NOT NULL
     ), journals AS (
       SELECT * FROM ledger_transactions WHERE transaction_type = 'simulated-investment-settle'
     )
     SELECT i.id AS investment_id, j.id AS journal_id
     FROM settled i FULL JOIN journals j ON j.reference_id = i.id::text
     CROSS JOIN LATERAL (
       SELECT (i.principal + i.profit) * (i.fee_percent / 100::numeric) AS fee
     ) calc
     WHERE i.id IS NULL OR j.id IS NULL OR i.status <> 'settled' OR j.status <> 'posted'
        OR i.settlement_id IS DISTINCT FROM j.id OR j.created_at < i.matures_at
        OR j.idempotency_key IS DISTINCT FROM 'simulated-investment-settle:' || i.id
        OR (SELECT count(*) FROM ledger_entries e WHERE e.transaction_id = j.id) <> 4
        OR EXISTS (
          SELECT * FROM (VALUES
            (i.invested_id, 'debit', i.principal::numeric),
            ($1::bigint, 'debit', i.profit),
            (i.available_id, 'credit', i.principal + i.profit - calc.fee),
            ($2::bigint, 'credit', calc.fee)
          ) expected(account_id, entry_type, amount)
          EXCEPT ALL
          SELECT e.account_id, e.entry_type, e.amount FROM ledger_entries e
          WHERE e.transaction_id = j.id AND e.currency = 'USDT'
        )
     ORDER BY i.id, j.id`, [reserveId, feeId]
  );
  return rows;
}
