export async function createSimulationWithdrawalTables(pool) {
  await pool.query("CREATE TABLE simulation_reviewers (user_id bigint PRIMARY KEY REFERENCES users(id), active boolean NOT NULL)");
  await pool.query(`CREATE TABLE simulation_withdrawals (
    id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id), request_key text NOT NULL,
    amount numeric(36,8) NOT NULL CHECK (amount > 0),
    available_id bigint NOT NULL REFERENCES ledger_accounts(id), held_id bigint NOT NULL REFERENCES ledger_accounts(id),
    status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'cancelled')),
    cancelled_by_reviewer bigint REFERENCES simulation_reviewers(user_id),
    release_id bigint UNIQUE REFERENCES ledger_transactions(id), UNIQUE (user_id, request_key)
  )`);
}
