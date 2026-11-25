-- REVIEW ONLY. Never run automatically or on production without separate approval,
-- catalog and privilege review, verified restore, and a maintenance window.
-- Requires preinstalled, independently reviewed btree_gist in public.
-- No extension creation, grants, backfill or financial runtime wiring.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;
CREATE TABLE public.deposit_address_ownership_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 wallet_id bigint NOT NULL REFERENCES public.wallets(id) CHECK (wallet_id > 0),
 user_id bigint NOT NULL REFERENCES public.users(id) CHECK (user_id > 0),
 chain_id integer NOT NULL CHECK (chain_id = 56),
 wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$' AND wallet_address <> '0x' || repeat('0',40)),
 start_block numeric(78,0) NOT NULL CHECK (start_block >= 0 AND start_block <= 115792089237316195423570985008687907853269984665640564039457584007913129639935::numeric),
 end_block numeric(78,0) CHECK (end_block IS NULL OR (end_block > start_block AND end_block <= 115792089237316195423570985008687907853269984665640564039457584007913129639935::numeric)),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 verified_source text NOT NULL CHECK (length(trim(verified_source)) >= 8),
 CONSTRAINT ownership_wallet_unique_start UNIQUE (wallet_id,start_block),
 CONSTRAINT ownership_wallet_interval_no_overlap EXCLUDE USING gist (
  wallet_id public.gist_int8_ops WITH =,
  (numrange(start_block,end_block,'[)')) WITH &&
 ),
 CONSTRAINT ownership_wallet_chain_unique_start UNIQUE (chain_id,wallet_address,start_block),
 CONSTRAINT ownership_interval_no_overlap EXCLUDE USING gist (
  chain_id public.gist_int4_ops WITH =,
  wallet_address public.gist_text_ops WITH =,
  (numrange(start_block,end_block,'[)')) WITH &&
 )
);
CREATE FUNCTION public.validate_deposit_ownership_wallet_identity()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE wallet_record record;
BEGIN
 SELECT chain_id,wallet_address,is_platform_controlled INTO wallet_record
 FROM public.wallets WHERE id=NEW.wallet_id FOR SHARE;
 IF NOT FOUND OR wallet_record.chain_id IS DISTINCT FROM NEW.chain_id
    OR wallet_record.wallet_address IS DISTINCT FROM NEW.wallet_address
    OR wallet_record.is_platform_controlled IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Historical deposit wallet identity mismatch';
 END IF;
 RETURN NEW;
END
$$;
CREATE TRIGGER deposit_ownership_wallet_identity
BEFORE INSERT ON public.deposit_address_ownership_history
FOR EACH ROW EXECUTE FUNCTION public.validate_deposit_ownership_wallet_identity();
CREATE FUNCTION public.reject_deposit_ownership_history_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'Deposit ownership history is immutable';
END
$$;
CREATE TRIGGER deposit_ownership_history_immutable
BEFORE UPDATE OR DELETE ON public.deposit_address_ownership_history
FOR EACH ROW EXECUTE FUNCTION public.reject_deposit_ownership_history_mutation();
CREATE TRIGGER deposit_ownership_history_no_truncate
BEFORE TRUNCATE ON public.deposit_address_ownership_history
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_deposit_ownership_history_mutation();
ALTER TABLE public.deposit_address_ownership_history ENABLE ALWAYS TRIGGER deposit_ownership_wallet_identity;
ALTER TABLE public.deposit_address_ownership_history ENABLE ALWAYS TRIGGER deposit_ownership_history_immutable;
ALTER TABLE public.deposit_address_ownership_history ENABLE ALWAYS TRIGGER deposit_ownership_history_no_truncate;
COMMIT;
-- Open-ended immutable intervals cannot later be closed by UPDATE.
-- Lifecycle, independently verified provenance and privileged bypass remain review gates.
