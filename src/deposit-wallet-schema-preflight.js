// Read-only launch preflight: do not assume production wallet schema matches fixtures.
// This function never assigns addresses, credits balances or changes database objects.
const REQUIRED = {
  users: ["id"],
  wallets: ["id"],
  user_wallet_assignments: ["user_id"],
  wallet_transfers: ["id"],
  deposit_requests: ["id", "user_id"],
  ledger_accounts: ["id", "user_id", "account_type", "currency"],
  ledger_transactions: ["id", "transaction_type", "idempotency_key", "status"],
  ledger_entries: ["transaction_id", "account_id", "entry_type", "amount", "currency"]
};

export async function inspectDepositWalletSchema(pool) {
  const tables = Object.keys(REQUIRED);
  const result = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`, [tables]
  );
  const columns = new Map(tables.map(table => [table, new Map()]));
  for (const row of result.rows) {
    if (columns.has(row.table_name)) columns.get(row.table_name).set(row.column_name, {
      dataType: row.data_type, nullable: row.is_nullable === "YES"
    });
  }
  const missing = [];
  for (const [table, required] of Object.entries(REQUIRED)) {
    for (const column of required) if (!columns.get(table).has(column)) missing.push(table + "." + column);
  }
  const walletColumns = Object.fromEntries(["wallets", "user_wallet_assignments", "wallet_transfers", "deposit_requests"]
    .map(table => [table, Object.fromEntries(columns.get(table))]));
  return Object.freeze({
    readyForIntegration: missing.length === 0,
    missing,
    walletColumns,
    // Production deposits must remain disabled even if all columns are present:
    // indexes, FK ownership, network config and actual migrations require review.
    realDepositsEnabled: false
  });
}
