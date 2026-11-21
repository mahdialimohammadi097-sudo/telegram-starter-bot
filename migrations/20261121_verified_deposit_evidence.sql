-- PROFINO reviewed-candidate migration. DO NOT AUTO-APPLY TO PRODUCTION.
-- Requires operator review, backup and explicit separate migration approval.
BEGIN;
CREATE TABLE IF NOT EXISTS public.verified_deposit_evidence (
 event_key text PRIMARY KEY,
 block_hash text NOT NULL,
 block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
 token_contract text NOT NULL,
 deposit_address text NOT NULL,
 amount_base_units numeric(78,0) NOT NULL CHECK (amount_base_units > 0),
 observed_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT verified_deposit_evidence_block_hash_format CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
 CONSTRAINT verified_deposit_evidence_token_format CHECK (token_contract ~ '^0x[0-9a-fA-F]{40}$'),
 CONSTRAINT verified_deposit_evidence_address_format CHECK (deposit_address ~ '^0x[0-9a-fA-F]{40}$')
);
COMMIT;
