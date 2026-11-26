-- REVIEW ONLY: isolated synthetic withdrawal contract, not a production migration.
ALTER TABLE simulation_withdrawals
 ADD CONSTRAINT simulation_release_pointer_review CHECK (
   (status='cancelled')=(release_id IS NOT NULL)
   AND (status='cancelled' OR cancelled_by_reviewer IS NULL)),
 ADD CONSTRAINT simulation_submission_review CHECK (
   CASE WHEN status IN ('pending_receipt','paid') THEN
     (destination ~ '^0x[0-9a-f]{40}$' AND destination <> '0x'||repeat('0',40)
      AND submitted_hash ~ '^0x[0-9a-f]{64}$'
      AND simulation_payload IS NOT NULL AND octet_length(simulation_payload)>0) IS TRUE
   ELSE simulation_payload IS NULL END);

CREATE FUNCTION guard_simulation_withdrawal_review() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE journal_type text; journal_id bigint; credit_id bigint;
BEGIN
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Withdrawal history cannot be deleted' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.status<>'reserved' OR NOT EXISTS (
     SELECT 1 FROM ledger_accounts a JOIN ledger_accounts h ON h.user_id=a.user_id
     WHERE a.id=NEW.available_id AND h.id=NEW.held_id AND a.user_id=NEW.user_id
       AND a.account_type='AVAILABLE' AND h.account_type='WITHDRAWAL_HOLD'
       AND a.currency='USDT' AND h.currency='USDT'
   ) THEN RAISE EXCEPTION 'Invalid initial withdrawal identity' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF ROW(NEW.id,NEW.user_id,NEW.request_key,NEW.amount,NEW.available_id,NEW.held_id,NEW.destination)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.request_key,OLD.amount,OLD.available_id,OLD.held_id,OLD.destination)
 THEN RAISE EXCEPTION 'Withdrawal identity is immutable' USING ERRCODE='23514'; END IF;
 IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 IF OLD.status='reserved' AND NEW.status='pending_receipt' THEN
   IF NOT EXISTS (
     SELECT 1 FROM ledger_transactions j WHERE j.status='posted'
       AND j.transaction_type='sim-withdraw-reserve' AND j.reference_id=OLD.id::text
       AND j.idempotency_key='sim-withdraw-reserve:'||OLD.id::text
       AND (SELECT count(*) FROM ledger_entries e WHERE e.transaction_id=j.id)=2
       AND EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transaction_id=j.id AND e.account_id=OLD.available_id AND e.entry_type='debit' AND e.amount=OLD.amount AND e.currency='USDT')
       AND EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transaction_id=j.id AND e.account_id=OLD.held_id AND e.entry_type='credit' AND e.amount=OLD.amount AND e.currency='USDT')
   ) THEN RAISE EXCEPTION 'Missing reservation journal' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 ELSIF OLD.status='reserved' AND NEW.status='cancelled' THEN
   journal_type:='sim-withdraw-release'; journal_id:=NEW.release_id; credit_id:=OLD.available_id;
 ELSIF OLD.status='pending_receipt' AND NEW.status='paid' THEN
   IF ROW(NEW.submitted_hash,NEW.simulation_payload) IS DISTINCT FROM ROW(OLD.submitted_hash,OLD.simulation_payload)
      OR NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE id=NEW.clearing_id AND user_id IS NULL AND account_type='CLEARING' AND currency='USDT')
   THEN RAISE EXCEPTION 'Submission identity mismatch' USING ERRCODE='23514'; END IF;
   IF NEW.payout_event IS NULL OR split_part(NEW.payout_event,':',1)<>'97'
      OR split_part(NEW.payout_event,':',2)<>OLD.submitted_hash
      OR NEW.payout_event !~ '^97:0x[0-9a-f]{64}:(0|[1-9][0-9]*)$'
   THEN RAISE EXCEPTION 'Payout event identity mismatch' USING ERRCODE='23514'; END IF;
   journal_type:='sim-withdraw-payout'; journal_id:=NEW.payout_id; credit_id:=NEW.clearing_id;
 ELSE RAISE EXCEPTION 'Invalid withdrawal transition' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (
   SELECT 1 FROM ledger_transactions j WHERE j.id=journal_id AND j.status='posted'
    AND j.transaction_type=journal_type AND j.reference_id=OLD.id::text
    AND j.idempotency_key=journal_type||':'||OLD.id::text
    AND (SELECT count(*) FROM ledger_entries e WHERE e.transaction_id=j.id)=2
    AND EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transaction_id=j.id AND e.account_id=OLD.held_id AND e.entry_type='debit' AND e.amount=OLD.amount AND e.currency='USDT')
    AND EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transaction_id=j.id AND e.account_id=credit_id AND e.entry_type='credit' AND e.amount=OLD.amount AND e.currency='USDT')
 ) THEN RAISE EXCEPTION 'Withdrawal journal mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER simulation_withdrawal_history_review
BEFORE INSERT OR UPDATE OR DELETE ON simulation_withdrawals
FOR EACH ROW EXECUTE FUNCTION guard_simulation_withdrawal_review();
