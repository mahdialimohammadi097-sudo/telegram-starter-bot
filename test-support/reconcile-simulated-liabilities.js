// Simulation-only aggregate comparison. Expected obligations come from the
// independent request tables, not the ledger being checked. A single SQL
// statement uses one snapshot; no updates, external transfers or repair.
export async function reconcileSimulatedLiabilities(client) {
  const { rows } = await client.query(`
    WITH obligations AS (
      SELECT user_id, 'INVESTED'::text AS kind, sum(principal::numeric) AS expected
        FROM simulation_investments WHERE status='active' GROUP BY user_id
      UNION ALL
      SELECT user_id, 'WITHDRAWAL_HOLD', sum(amount)
        FROM simulation_withdrawals WHERE status IN ('reserved','pending_receipt') GROUP BY user_id
    ), actual AS (
      SELECT a.user_id, a.account_type AS kind, count(DISTINCT a.id) AS accounts,
             coalesce(sum(CASE WHEN t.status='posted' AND e.entry_type='credit' THEN e.amount
                               WHEN t.status='posted' AND e.entry_type='debit' THEN -e.amount
                               ELSE 0 END),0) AS balance
        FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id AND e.currency='USDT'
        LEFT JOIN ledger_transactions t ON t.id=e.transaction_id
        WHERE a.user_id IS NOT NULL AND a.currency='USDT'
          AND a.account_type IN ('INVESTED','WITHDRAWAL_HOLD')
        GROUP BY a.user_id,a.account_type
    ), comparison AS (
      SELECT coalesce(o.kind,a.kind) AS kind, coalesce(o.expected,0) AS expected,
             coalesce(a.balance,0) AS actual,
             coalesce(a.accounts,0) AS accounts
      FROM obligations o FULL JOIN actual a ON o.user_id=a.user_id AND o.kind=a.kind
    )
    SELECT count(*) FILTER (WHERE kind='INVESTED' AND (expected<>actual OR accounts<>1))::text AS investment_mismatches,
           count(*) FILTER (WHERE kind='WITHDRAWAL_HOLD' AND (expected<>actual OR accounts<>1))::text AS withdrawal_mismatches,
           count(*) FILTER (WHERE expected>0 AND accounts=0)::text AS missing_accounts,
           count(*) FILTER (WHERE accounts>1)::text AS duplicate_accounts
    FROM comparison
  `);
  const keys=["investment_mismatches","withdrawal_mismatches","missing_accounts","duplicate_accounts"];
  if(rows?.length!==1 || keys.some(k=>typeof rows[0][k]!=="string" || !/^(0|[1-9][0-9]*)$/.test(rows[0][k]))) {
    throw new Error("Incomplete simulated liability evidence");
  }
  const counts=Object.fromEntries(keys.map(k=>[k,rows[0][k]]));
  return {scope:"simulated-invested-and-held-only",counts,
    clean:keys.every(k=>counts[k]==="0"),custodyVerified:false,productionReady:false};
}
