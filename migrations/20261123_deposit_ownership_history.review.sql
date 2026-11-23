-- REVIEW ONLY: immutable chain-block ownership intervals for deposit addresses.
-- Do not run in production without separate owner authorization, restore-tested backup,
-- catalog comparison and an approved maintenance window.
-- No backfill: existing addresses have NO automatically trustworthy historical owner.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE public.deposit_address_ownership_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 wallet_id bigint NOT NULL REFERENCES public.wallets(id),
 user_id bigint NOT NULL REFERENCES public.users(id),
 chain_id bigint NOT NULL CHECK (chain_id=56),
 wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
 start_block numeric(78,0) NOT NULL CHECK (start_block>=0),
 end_block numeric(78,0) CHECK (end_block IS NULL OR end_block>start_block),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 verified_source text NOT NULL CHECK (length(trim(verified_source))>0),
 CONSTRAINT ownership_interval_no_overlap EXCLUDE USING gist (
   chain_id WITH =,
   wallet_address WITH =,
   numrange(start_block,COALESCE(end_block,1e78::numeric),'[)') WITH &&
 )
);
-- Immutable rows: correction requires a separately reviewed migration, not UPDATE/DELETE.
CREATE FUNCTION public.reject_deposit_ownership_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Deposit ownership history is immutable'; END $$;
CREATE TRIGGER deposit_ownership_history_immutable
BEFORE UPDATE OR DELETE ON public.deposit_address_ownership_history
FOR EACH ROW EXECUTE FUNCTION public.reject_deposit_ownership_history_mutation();
COMMIT;
-- No GRANT, no data backfill, no live deposit crediting.
