-- Candidate only. Never auto-apply to production.
-- Requires backup, isolated rehearsal and separate explicit migration approval.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE IF NOT EXISTS public.verified_deposit_evidence (
 event_key text PRIMARY KEY,
 block_hash text NOT NULL,
 block_number numeric(78,0) NOT NULL CHECK (block_number >= 0) CHECK (block_number <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric),
 token_contract text NOT NULL,
 deposit_address text NOT NULL,
 amount_base_units numeric(78,0) NOT NULL CHECK (amount_base_units > 0) CHECK (amount_base_units <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric),
 observed_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT verified_deposit_evidence_event_key_format CHECK (event_key ~ '^bsc:56:0x[0-9a-f]{64}:(0|[1-9][0-9]*)$'),
 CONSTRAINT verified_deposit_evidence_block_hash_format CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
 CONSTRAINT verified_deposit_evidence_token_format CHECK (token_contract ~ '^0x[0-9a-f]{40}$'),
 CONSTRAINT verified_deposit_evidence_address_format CHECK (deposit_address ~ '^0x[0-9a-f]{40}$')
);
-- Existing tables must be verified separately: IF NOT EXISTS does not repair them.
COMMIT;
