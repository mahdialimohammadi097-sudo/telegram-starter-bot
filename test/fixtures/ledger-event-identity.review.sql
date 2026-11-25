-- REVIEW FIXTURE ONLY. Not a deployment migration. Run only in disposable schema
-- inside an explicit transaction; validation must fail on preexisting conflicts.
-- Do not normalize or delete legacy financial records automatically.
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_confirmed_deposit_identity_review
CHECK (
  CASE WHEN transaction_type = 'confirmed-deposit'
    OR lower(coalesce(reference_id,'')) LIKE 'bsc:56:%'
    OR lower(coalesce(idempotency_key,'')) LIKE 'confirmed-deposit:%'
  THEN (
    transaction_type = 'confirmed-deposit'
    AND reference_id ~ '^bsc:56:0x[0-9a-f]{64}:(0|[1-9][0-9]*)$'
    AND idempotency_key = 'confirmed-deposit:' || reference_id
  ) IS TRUE
  ELSE true END
);
CREATE UNIQUE INDEX ledger_confirmed_deposit_event_review
ON ledger_transactions(reference_id)
WHERE transaction_type = 'confirmed-deposit';
