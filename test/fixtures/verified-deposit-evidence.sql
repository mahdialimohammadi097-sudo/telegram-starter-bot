-- Disposable PostgreSQL rehearsal fixture, not a production migration.
-- Named constraints match the read-only deposit schema audit contract.
CREATE TABLE verified_deposit_evidence (
  event_key text PRIMARY KEY CONSTRAINT verified_deposit_evidence_event_key_format CHECK (event_key ~ '^bsc:56:0x[0-9a-f]{64}:(0|[1-9][0-9]*)$'),
  block_hash text NOT NULL CONSTRAINT verified_deposit_evidence_block_hash_format CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  block_number numeric(78,0) NOT NULL CONSTRAINT verified_deposit_evidence_block_number_nonnegative CHECK (block_number >= 0),
  token_contract text NOT NULL CONSTRAINT verified_deposit_evidence_token_format CHECK (token_contract ~ '^0x[0-9a-f]{40}$'),
  deposit_address text NOT NULL CONSTRAINT verified_deposit_evidence_address_format CHECK (deposit_address ~ '^0x[0-9a-f]{40}$'),
  amount_base_units numeric(78,0) NOT NULL CONSTRAINT verified_deposit_evidence_amount_positive CHECK (amount_base_units > 0),
  observed_at timestamptz NOT NULL DEFAULT now()
);
