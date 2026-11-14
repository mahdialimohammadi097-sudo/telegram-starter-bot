export async function createSimulationWithdrawalTables(pool) {
  await pool.query("CREATE TABLE simulation_reviewers (user_id bigint PRIMARY KEY REFERENCES users(id), active boolean NOT NULL)");
  await pool.query(`CREATE TABLE simulation_withdrawals (
    id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id), request_key text NOT NULL,
    amount numeric(36,8) NOT NULL CHECK (amount > 0),
    available_id bigint NOT NULL REFERENCES ledger_accounts(id), held_id bigint NOT NULL REFERENCES ledger_accounts(id),
    status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'cancelled', 'paid')),
    destination text, payout_event text UNIQUE, payout_id bigint UNIQUE REFERENCES ledger_transactions(id),
    clearing_id bigint REFERENCES ledger_accounts(id),
    CHECK ((status = 'paid') = (payout_event IS NOT NULL) AND
           (status = 'paid') = (payout_id IS NOT NULL) AND (status = 'paid') = (clearing_id IS NOT NULL)),
    cancelled_by_reviewer bigint REFERENCES simulation_reviewers(user_id),
    release_id bigint UNIQUE REFERENCES ledger_transactions(id), UNIQUE (user_id, request_key)
  )`);
}
