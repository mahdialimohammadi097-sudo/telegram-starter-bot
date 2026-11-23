-- REVIEW ONLY. Never execute on production without separate owner authorization,
-- verified isolated backup restore, catalog review and maintenance window.
-- No automatic backfill: current assignments cannot prove historical ownership.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE public.deposit_address_ownership_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 wallet_id bigint NOT NULL REFERENCES public.wallets(id),
 user_id bigint NOT NULL REFERENCES public.users(id),
 chain_id bigint NOT NULL CHECK (chain_id = 56),
 wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
 start_block numeric(78,0) NOT NULL CHECK (start_block >= 0),
 end_block numeric(78,0) CHECK (end_block IS NULL OR end_block > start_block),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 verified_source text NOT NULL CHECK (length(trim(verified_source)) >= 8),
 CONSTRAINT ownership_wallet_chain_unique_start UNIQUE (chain_id,wallet_address,start_block),
 CONSTRAINT ownership_interval_no_overlap EXCLUDE USING gist (
  chain_id WITH =,
  wallet_address WITH =,
  (numrange(start_block,COALESCE(end_block,1e78::numeric),'[)')) WITH &&
 )
);
-- Reject forged wallet identity at insert time; lock the wallet row against concurrent edits.
-- This does not independently authenticate the historical user or block interval.
CREATE FUNCTION public.validate_deposit_ownership_wallet_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
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
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Deposit ownership history is immutable';
END
$$;
CREATE TRIGGER deposit_ownership_history_immutable
BEFORE UPDATE OR DELETE ON public.deposit_address_ownership_history
FOR EACH ROW EXECUTE FUNCTION public.reject_deposit_ownership_history_mutation();
COMMIT;
-- No GRANT, no production data writes, no runtime wiring.
