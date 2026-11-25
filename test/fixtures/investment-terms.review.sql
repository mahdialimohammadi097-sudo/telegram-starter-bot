-- REVIEW ONLY. Synthetic investment contract, never a production migration.
ALTER TABLE simulation_investments
  ADD CONSTRAINT simulation_investment_terms_review CHECK (
    principal IN (10,25,50,75,100)
    AND CASE plan
      WHEN 'STARTER' THEN profit_percent=4 AND fee_percent=2 AND matures_at=opened_at+interval '240 hours'
      WHEN 'SMART' THEN profit_percent=14 AND fee_percent=4 AND matures_at=opened_at+interval '720 hours'
      WHEN 'PRO' THEN profit_percent=40 AND fee_percent=6 AND matures_at=opened_at+interval '2160 hours'
      ELSE false
    END
  ),
  ADD CONSTRAINT simulation_investment_state_review CHECK (
    (status='active' AND settlement_id IS NULL) OR (status='settled' AND settlement_id IS NOT NULL)
  );

CREATE FUNCTION guard_simulation_investment_review() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Investment history cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.id,NEW.user_id,NEW.request_id,NEW.plan,NEW.principal,NEW.profit_percent,
      NEW.fee_percent,NEW.opened_at,NEW.matures_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.request_id,OLD.plan,OLD.principal,
      OLD.profit_percent,OLD.fee_percent,OLD.opened_at,OLD.matures_at) THEN
    RAISE EXCEPTION 'Investment terms and maturity are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status='settled' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Settled investment cannot be changed' USING ERRCODE='23514';
  END IF;
  IF OLD.status='active' AND NEW.status='settled' THEN
    IF OLD.matures_at > now() THEN
      RAISE EXCEPTION 'Investment is not due' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM ledger_transactions j WHERE j.id=NEW.settlement_id
      AND j.status='posted' AND j.transaction_type='simulated-investment-settle'
      AND j.reference_id=OLD.id::text
      AND j.idempotency_key='simulated-investment-settle:'||OLD.id::text
      AND j.created_at>=OLD.matures_at
    ) THEN
      RAISE EXCEPTION 'Settlement journal identity mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER simulation_investment_history_review
BEFORE UPDATE OR DELETE ON simulation_investments
FOR EACH ROW EXECUTE FUNCTION guard_simulation_investment_review();
