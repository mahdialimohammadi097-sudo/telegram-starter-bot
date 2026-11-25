-- Disposable PostgreSQL rehearsal fixture, not a production migration.
CREATE TABLE verified_deposit_evidence (
  event_key text PRIMARY KEY CHECK (event_key ~ '^bsc:56:0x[0-9a-f]{64}:(0|[1-9][0-9]*)$'),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  block_number numeric(78,0) NOT NULL CHECK (block_number >= 0) CHECK (block_number <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric),
  token_contract text NOT NULL CHECK (token_contract ~ '^0x[0-9a-f]{40}$'),
  deposit_address text NOT NULL CHECK (deposit_address ~ '^0x[0-9a-f]{40}$'),
  amount_base_units numeric(78,0) NOT NULL CHECK (amount_base_units > 0) CHECK (amount_base_units <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric),
  observed_at timestamptz NOT NULL DEFAULT now()
);
