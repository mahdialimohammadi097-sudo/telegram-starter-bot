-- Candidate only. Never auto-apply to production.
-- Requires backup, isolated rehearsal and separate explicit migration approval.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Resolve CHECK operators, types and defaults against the built-in catalog.
SET LOCAL search_path = pg_catalog;
-- Create only: an existing relation is an unexpected state requiring review.
CREATE TABLE public.verified_deposit_evidence (
 event_key text PRIMARY KEY,
 block_hash text NOT NULL,
 block_number numeric NOT NULL CHECK (pg_catalog.scale(block_number) = 0) CHECK (block_number >= 0) CHECK (block_number <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric),
 token_contract text NOT NULL,
 deposit_address text NOT NULL,
 amount_base_units numeric NOT NULL CHECK (pg_catalog.scale(amount_base_units) = 0) CHECK (amount_base_units > 0) CHECK (amount_base_units <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric),
 observed_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT verified_deposit_evidence_event_key_format CHECK (event_key ~ '^bsc:56:0x[0-9a-f]{64}:(0|[1-9][0-9]{0,77})$'),
 CONSTRAINT verified_deposit_evidence_block_hash_format CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
 CONSTRAINT verified_deposit_evidence_token_format CHECK (token_contract ~ '^0x[0-9a-f]{40}$'),
 CONSTRAINT verified_deposit_evidence_address_format CHECK (deposit_address ~ '^0x[0-9a-f]{40}$'),
 CONSTRAINT verified_deposit_evidence_token_nonzero CHECK (token_contract <> '0x0000000000000000000000000000000000000000'),
 CONSTRAINT verified_deposit_evidence_address_nonzero CHECK (deposit_address <> '0x0000000000000000000000000000000000000000'),
 CONSTRAINT verified_deposit_evidence_log_index_uint256 CHECK (
   CASE WHEN pg_catalog.split_part(event_key, ':', 4) ~ '^(0|[1-9][0-9]{0,77})$'
     THEN pg_catalog.split_part(event_key, ':', 4)::numeric <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric
     ELSE false END)
);
-- Preserve receipt evidence after insertion. Ordinary UPDATE, DELETE and
-- TRUNCATE must fail even in replica mode. Owners/privileged roles can still
-- disable the guard; separately review effective grants before production.
CREATE FUNCTION public.reject_verified_deposit_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
 RAISE EXCEPTION 'Verified deposit evidence is immutable' USING ERRCODE='55000';
END
$guard$;
CREATE TRIGGER verified_deposit_evidence_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE ON public.verified_deposit_evidence
 FOR EACH STATEMENT EXECUTE FUNCTION public.reject_verified_deposit_evidence_mutation();
ALTER TABLE public.verified_deposit_evidence ENABLE ALWAYS TRIGGER verified_deposit_evidence_immutable;
REVOKE ALL ON TABLE public.verified_deposit_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_verified_deposit_evidence_mutation() FROM PUBLIC;
-- Never drop, replace or repair an existing relation with this candidate.
COMMIT;
