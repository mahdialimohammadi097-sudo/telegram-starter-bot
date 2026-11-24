-- REVIEW ONLY. Not a runtime migration. Do not execute in production.
-- Requires independent schema, permissions, provenance and accounting review.
BEGIN;
CREATE TABLE public.verified_deposit_evidence (
 event_key text PRIMARY KEY CHECK (length(event_key)<=160 AND event_key ~ '^bsc:56:0x[0-9a-f]{64}:(0|[1-9][0-9]*)$'),
 block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
 block_number numeric(78,0) NOT NULL CHECK (block_number>=0 AND block_number<power(2::numeric,256)),
 token_contract text NOT NULL CHECK (token_contract ~ '^0x[0-9a-f]{40}$'),
 deposit_address text NOT NULL CHECK (deposit_address ~ '^0x[0-9a-f]{40}$'),
 amount_base_units numeric(78,0) NOT NULL CHECK (amount_base_units>0 AND amount_base_units<power(2::numeric,256)),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.deposit_address_ownership_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 wallet_id bigint NOT NULL REFERENCES public.wallets(id),
 user_id bigint NOT NULL REFERENCES public.users(id),
 chain_id integer NOT NULL CHECK (chain_id=56),
 wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
 start_block numeric(78,0) NOT NULL CHECK (start_block>=0 AND start_block<power(2::numeric,256)),
 end_block numeric(78,0) CHECK (end_block>start_block AND end_block<power(2::numeric,256)),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(chain_id,wallet_address,start_block)
);
-- Native GiST numeric ranges enforce non-overlapping ownership intervals,
-- including concurrent inserts. Requires no additional extension.
ALTER TABLE public.deposit_address_ownership_history
 ADD CONSTRAINT deposit_history_no_overlap EXCLUDE USING gist (
 numrange(('x'||substring(wallet_address from 3 for 10))::bit(40)::bigint::numeric,
          ('x'||substring(wallet_address from 3 for 10))::bit(40)::bigint::numeric,'[]') WITH &&,
 numrange(('x'||substring(wallet_address from 13 for 10))::bit(40)::bigint::numeric,
          ('x'||substring(wallet_address from 13 for 10))::bit(40)::bigint::numeric,'[]') WITH &&,
 numrange(('x'||substring(wallet_address from 23 for 10))::bit(40)::bigint::numeric,
          ('x'||substring(wallet_address from 23 for 10))::bit(40)::bigint::numeric,'[]') WITH &&,
 numrange(('x'||substring(wallet_address from 33 for 10))::bit(40)::bigint::numeric,
          ('x'||substring(wallet_address from 33 for 10))::bit(40)::bigint::numeric,'[]') WITH &&,
 numrange(start_block,end_block,'[)') WITH &&
 );
-- Evidence rows are append-only; corrections require a separately reviewed reconciliation design.
CREATE FUNCTION public.reject_deposit_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $guard$
BEGIN
 RAISE EXCEPTION 'Deposit evidence is immutable' USING ERRCODE='55000';
END;
$guard$;
CREATE TRIGGER deposit_evidence_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE ON public.verified_deposit_evidence
 FOR EACH STATEMENT EXECUTE FUNCTION public.reject_deposit_evidence_mutation();
-- Immutable provenance, role grants and reconciliation
-- are unresolved. No historical assignments may be inferred or backfilled.
-- Deliberate rollback: this proposal cannot persist changes as supplied.
ROLLBACK;
