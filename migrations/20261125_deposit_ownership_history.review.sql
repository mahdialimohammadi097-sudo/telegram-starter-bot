-- REVIEW ONLY. Never run automatically or on production without separate approval,
-- catalog and privilege review, verified restore, and a maintenance window.
-- Requires preinstalled, independently reviewed btree_gist in public.
-- No extension creation, grants, backfill or financial runtime wiring.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;
-- Refuse look-alike operator classes that are not members of the reviewed extension.
DO $preflight$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_extension e
  JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
  WHERE e.extname='btree_gist' AND n.nspname='public'
 ) OR (
  SELECT count(DISTINCT o.opcname)
  FROM pg_catalog.pg_opclass o
  JOIN pg_catalog.pg_namespace n ON n.oid=o.opcnamespace
  JOIN pg_catalog.pg_am a ON a.oid=o.opcmethod
  JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_opclass'::regclass
    AND d.objid=o.oid AND d.objsubid=0 AND d.deptype='e'
    AND d.refclassid='pg_catalog.pg_extension'::regclass
  JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
  WHERE n.nspname='public' AND a.amname='gist' AND e.extname='btree_gist'
    AND ((o.opcname='gist_int8_ops' AND o.opcintype='pg_catalog.int8'::regtype)
      OR (o.opcname='gist_int4_ops' AND o.opcintype='pg_catalog.int4'::regtype)
      OR (o.opcname='gist_text_ops' AND o.opcintype='pg_catalog.text'::regtype))
 ) <> 3 THEN
  RAISE EXCEPTION 'Historical ownership extension prerequisites not confirmed';
 END IF;
 -- Restrict the candidate to the reviewed underlying types and standalone permanent ordinary tables.
 IF (
  SELECT count(*)
  FROM (VALUES
   (pg_catalog.to_regclass('public.users'), 'id', ARRAY['pg_catalog.int4'::regtype,'pg_catalog.int8'::regtype]),
   (pg_catalog.to_regclass('public.wallets'), 'id', ARRAY['pg_catalog.int4'::regtype,'pg_catalog.int8'::regtype]),
   (pg_catalog.to_regclass('public.wallets'), 'chain_id', ARRAY['pg_catalog.int4'::regtype,'pg_catalog.int8'::regtype]),
   (pg_catalog.to_regclass('public.wallets'), 'wallet_address', ARRAY['pg_catalog.text'::regtype,'pg_catalog.varchar'::regtype]),
   (pg_catalog.to_regclass('public.wallets'), 'is_platform_controlled', ARRAY['pg_catalog.bool'::regtype])
  ) AS expected(rel, col, types)
  JOIN pg_catalog.pg_class c ON c.oid=expected.rel AND c.relkind='r' AND c.relpersistence='p'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_inherits i
      WHERE i.inhparent=c.oid OR i.inhrelid=c.oid
    )
  JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=expected.col
   AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid=ANY(expected.types)
 ) <> 5 THEN
  RAISE EXCEPTION 'Historical ownership source column prerequisites not confirmed';
 END IF;
END
$preflight$;
CREATE TABLE public.deposit_address_ownership_history (
 id bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.deposit_address_ownership_history_id_seq) PRIMARY KEY,
 wallet_id bigint NOT NULL REFERENCES public.wallets(id) CHECK (wallet_id > 0),
 user_id bigint NOT NULL REFERENCES public.users(id) CHECK (user_id > 0),
 chain_id integer NOT NULL CHECK (chain_id = 56),
 wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$' AND wallet_address <> '0x' || repeat('0',40)),
 -- Unconstrained numeric avoids rounding fractional inputs before CHECK.
 start_block numeric NOT NULL CHECK (pg_catalog.scale(start_block)=0 AND start_block >= 0 AND start_block <= 115792089237316195423570985008687907853269984665640564039457584007913129639935::numeric),
 end_block numeric NOT NULL CHECK (pg_catalog.scale(end_block)=0 AND end_block > start_block AND end_block <= 115792089237316195423570985008687907853269984665640564039457584007913129639935::numeric),
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
 -- Internal FK triggers can be suppressed in replica mode. Check the user
 -- in the ALWAYS identity trigger as well, without bypassing row security.
 PERFORM 1 FROM public.users WHERE id=NEW.user_id FOR KEY SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Historical deposit user identity mismatch' USING ERRCODE='23503';
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
-- Default privileges can include PUBLIC grants. Explicitly revoke them from
-- these new objects; named role grants and ownership still require live review.
REVOKE ALL ON TABLE public.deposit_address_ownership_history FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.deposit_address_ownership_history_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_deposit_ownership_wallet_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_deposit_ownership_history_mutation() FROM PUBLIC;
COMMIT;
-- Only finite, independently established historical intervals are candidates for insertion.
-- Consecutive verified intervals can be appended without editing earlier history.
-- Never infer coverage beyond an observed boundary or from a current assignment.
-- This is not an active-assignment lifecycle; provenance, privileges and live integration remain gates.
