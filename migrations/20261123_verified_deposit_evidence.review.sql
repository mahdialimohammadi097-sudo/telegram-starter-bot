-- PROFINO proposed additive migration. REVIEW AND TEST BEFORE ANY PRODUCTION EXECUTION.
-- Never execute automatically on bot startup. Requires approved maintenance window,
-- verified backup, preflight of the existing catalog, and an operator-controlled role.
-- Intentionally no IF NOT EXISTS: an unexpected existing table must fail closed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE public.verified_deposit_evidence (
  event_key text PRIMARY KEY,
  block_hash text NOT NULL,
  block_number numeric(78,0) NOT NULL,
  token_contract text NOT NULL,
  deposit_address text NOT NULL,
  amount_base_units numeric(78,0) NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verified_deposit_evidence_event_key_format
    CHECK (event_key ~ '^bsc:56:0x[0-9a-f]{64}:(0|[1-9][0-9]*)$'),
  CONSTRAINT verified_deposit_evidence_block_hash_format
    CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT verified_deposit_evidence_token_format
    CHECK (token_contract ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT verified_deposit_evidence_address_format
    CHECK (deposit_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT verified_deposit_evidence_block_number_nonnegative
    CHECK (block_number >= 0),
  CONSTRAINT verified_deposit_evidence_amount_positive
    CHECK (amount_base_units > 0)
);
COMMIT;
-- No grants, runtime wiring, chain monitoring, credits, withdrawals or live activation.
