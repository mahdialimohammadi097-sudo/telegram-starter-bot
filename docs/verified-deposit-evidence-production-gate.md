# Verified deposit evidence — production migration gate (NOT APPROVED)

Scope: additive table creation only. This is **not** authorization to accept, credit, or withdraw real USDT. No bot restart, auto-migration, or feature flag changes are part of this procedure.

## Preconditions (all mandatory)

1. Owner explicitly approves this **schema-only maintenance** after independent engineering review. Financial activation requires a separate explicit authorization.
2. Confirm the target is the intended FadeHost PostgreSQL 17 production database using non-secret database metadata; never publish the connection URL, credentials, or wallet records.
3. Verify a recent restorable backup and successful isolated restore rehearsal. Stop if backup/restore cannot be confirmed.
4. Confirm bot deployment/version and that no application code is already writing to `verified_deposit_evidence`.
5. Re-run `node scripts/fadehost-schema-audit.js` read-only. Stop if the reported missing set has changed, the table already exists, or other unexpected differences are present.
6. Review migration SQL in `migrations/20261123_verified_deposit_evidence.review.sql`, including PostgreSQL role, permissions and change window. Test it on a disposable PostgreSQL 17 clone. The automated test uses an isolated schema and does not replace a production catalog review.

## Operator-controlled execution (only after prerequisites)

- Execute the reviewed SQL file exactly once with a trusted PostgreSQL client configured to stop on errors, as an authorized operator. Do not paste SQL into a scheduled recurring job.
- The file uses a transaction and short lock/statement timeouts; an existing table causes an error and rollback rather than silent alteration.
- Do not grant new privileges or enable runtime deposit/credit handlers as part of this migration.

## Post-change verification

1. Run the same read-only schema audit. Record only `ready` and sanitized `missing` values. Its `ready:true` means only its **limited schema checks** passed.
2. Run the stronger `scripts/deposit-preflight.js` with a dedicated **read-only** `PROFINO_AUDIT_DATABASE_URL` connection after confirming the script is available in the deployed/reviewed operator environment. It additionally checks type, precision, nullability, foreign keys, check constraints and wallet uniqueness.
3. Stop release if either audit fails, if active wallet assignment collisions exist, or if a required index is absent. Preserve evidence for remediation without printing sensitive records.
4. Independently reconcile ledger invariants, deposit idempotency, RPC confirmations, supported token/network configuration, admin authorization, monitoring, rollback/recovery and compliance before requesting separate owner approval for live deposits.

## Failure handling

- On SQL error, verify transaction rollback and stop; do **not** retry blindly or drop/recreate any table.
- On post-change audit failure, disable any pending release path; retain data and investigate. Do not run destructive rollback against a table that might contain evidence.
- Never treat this document, passing CI, or a schema-only `ready:true` as approval to move funds.
