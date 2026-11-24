-- REVIEW ONLY. Not a runtime migration. Do not execute in production.
-- Requires independent schema, permissions, provenance and accounting review.
BEGIN;
CREATE TABLE public.verified_deposit_evidence (
 event_key text PRIMARY KEY CHECK (CASE WHEN event_key ~ '^bsc:56:0x[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$' THEN split_part(event_key, ':', 4)::numeric <= 4294967295 ELSE false END),
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
-- Ownership identity is immutable. Only a previously open interval may be closed once.
CREATE FUNCTION public.guard_deposit_ownership_history() RETURNS trigger
LANGUAGE plpgsql AS $history$
BEGIN
 IF TG_OP <> 'UPDATE' THEN
  RAISE EXCEPTION 'Ownership history cannot be removed' USING ERRCODE='55000';
 END IF;
 IF ROW(NEW.id,NEW.wallet_id,NEW.user_id,NEW.chain_id,NEW.wallet_address,NEW.start_block,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.wallet_id,OLD.user_id,OLD.chain_id,OLD.wallet_address,OLD.start_block,OLD.created_at)
    OR OLD.end_block IS NOT NULL OR NEW.end_block IS NULL THEN
  RAISE EXCEPTION 'Ownership history identity is immutable' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$history$;
CREATE TRIGGER deposit_history_guard
 BEFORE UPDATE OR DELETE ON public.deposit_address_ownership_history
 FOR EACH ROW EXECUTE FUNCTION public.guard_deposit_ownership_history();
CREATE TRIGGER deposit_history_no_truncate
 BEFORE TRUNCATE ON public.deposit_address_ownership_history
 FOR EACH STATEMENT EXECUTE FUNCTION public.guard_deposit_ownership_history();
-- Explicitly deny implicit PUBLIC privileges; the owner can still bypass guards.
REVOKE ALL ON TABLE public.verified_deposit_evidence, public.deposit_address_ownership_history FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_deposit_evidence_mutation(), public.guard_deposit_ownership_history() FROM PUBLIC;
-- Dedicated non-owner runtime role and narrowly scoped grants remain mandatory.
-- Immutable provenance, role grants and reconciliation
-- are unresolved. No historical assignments may be inferred or backfilled.
-- Deliberate rollback: this proposal cannot persist changes as supplied.
ROLLBACK;
