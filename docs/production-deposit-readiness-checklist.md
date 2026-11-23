# PROFINO production deposit gate — read-only evidence checklist

**Status: BLOCKED.** Passing GitHub CI and the disposable PostgreSQL restore drill do not establish that the FadeHost production database has a restorable backup or a compatible schema. This is an operator checklist, not permission to activate funds.

## 1. Preserve and verify the production backup (before migrations)

- Identify the exact FadeHost `profino-db` production instance, region and PostgreSQL version using the hosting control panel; do not copy connection credentials into chat, issues or CI logs.
- Create a production-consistent backup through the approved host backup mechanism. Record only the backup identifier, timestamp, size and retention in a private audit record.
- Restore that backup into a **separate isolated non-production** PostgreSQL 17 instance with access controls and no bot credentials or outgoing payment access. Verify expected schemas, row counts and ledger invariants without exporting customer data to logs.
- Record restoration result, operator, timestamp and any discrepancies. **No successful restore = no production migration and no financial activation.**

## 2. Run the read-only production preflight

- Provision a dedicated read-only PostgreSQL role; ensure no DDL/DML permissions. Set `PROFINO_AUDIT_DATABASE_URL` only in a restricted execution environment.
- Execute `node scripts/deposit-preflight.js` against production under a read-only transaction. Capture sanitized JSON only; never log the connection URL or credentials.
- The report's `ready` field means **catalog and active-assignment structural readiness only**. `financialActivationReady` remains `false`.
- Investigate each missing or incompatible catalog element before drafting a reviewed additive migration. Do not run `migrations/20261123_verified_deposit_evidence.review.sql` without backup, rehearsal and separate owner approval.

## 3. Independently verify the historical wallet contract

- Read-only inspect actual `wallets` and `user_wallet_assignments` columns, indexes, constraints and assignment history. The current reviewed contract has no mandatory start/end block boundaries.
- Prove that the destination address belonged uniquely to the intended user **at the transfer block**, not merely at inspection time. Ambiguous or reassigned addresses must fail closed.
- A caller-supplied `historyVerified` flag is not independent evidence. Do not wire the offline historical assignment helper into live crediting without trusted immutable historical storage and concurrency tests.

## 4. Financial release prerequisites

- Independently verify mainnet chain ID, canonical block, confirmations/finality, successful transaction receipt, Transfer log, approved token contract, configured token decimals and exact amount.
- Prove atomic ledger posting, unique event idempotency, account ownership, admin authorization, reconciliation and negative/rollback/concurrency cases.
- Obtain documented security review, accounting reconciliation, operational sign-off and **explicit owner authorization** for each production-changing step and, separately, live USDT operations.

**No live deposit collection, withdrawal or settlement is authorized by this checklist.**

## 5. Observed production read-only audit — 2026-11-23

Source: Super Admin Telegram startup report emitted by the deployed read-only audit on `main`. This is **reported metadata**, not a backup or independent migration authorization.

- Bot and PostgreSQL connected; core inventory: **25/25** expected tables, **69** indexes and **16** user-defined triggers.
- `structuralReady=false`, `financialActivationReady=false`, `realDepositsEnabled=false`.
- `verified_deposit_evidence`: six required columns absent in catalog; unique `event_key` index absent.
- `deposit_address_ownership_history`: nine required columns absent in catalog.
- All other required columns checked by the startup audit were reported present. This does **not** verify their types, constraints, ownership provenance, ledger integrity or chain finality.
- The absence of columns is consistent with missing tables, but table absence itself has **not** been separately verified from the report.
- The reviewed SQL files are `migrations/20261123_verified_deposit_evidence.review.sql` and `migrations/20261123_deposit_ownership_history.review.sql`. **Do not apply either to production yet.**

### Next authorized decision gate

1. Verify that an actual production backup exists and successfully restore it in an isolated PostgreSQL 17 environment; record only nonsecret evidence.
2. Compare the production catalog with both reviewed SQL migrations and rehearse on the restored copy.
3. Obtain explicit owner approval for the **specific production schema migration** after security and accounting review. This is separate from permission to activate real USDT.
4. Repeat the read-only startup audit after any separately authorized migration and retain sanitized results.

No backup restore evidence, production migration authorization, or live USDT activation has been provided in this report.

## 6. FadeHost backup inventory observed by owner — 2026-11-23

The owner supplied the FadeHost `profino-db` panel showing PostgreSQL 17 running, private-only networking, and eight encrypted off-node backup snapshots. The newest listed snapshot is **1405/09/02 17:14:44** (Iranian calendar), ID prefix **f62ddb8e**, displayed size **129.1 KB**. These are nonsecret snapshot identifiers and metadata; no passwords or connection URLs are retained here.

**Evidence level: BACKUP LISTED, RESTORE UNVERIFIED.** A visible Restore button does not establish a successful isolated restore, consistency of ledger contents, or retention guarantees. Do not click Restore on the production instance. Do not delete existing snapshots.

At the time of this inventory, all four PR #114 CI workflow suites passed: PostgreSQL 17 disposable restore drill, catalog ownership PostgreSQL, integration PostgreSQL financial matrix, and integration ledger validator regression. These suites do not use or validate the actual FadeHost backup.

The owner plans to decide about hosting payments separately. This project step must not depend on buying a plan or incur extra charges. Keep production migrations and real USDT disabled until the independent production restore, security/accounting checks, and explicit owner authorization are complete.

## 7. Production catalog compatibility — non-mutating Console query

The 2026-11-23 startup report checks **column names**, not PostgreSQL data types, nullability, FK targets or whether the missing tables themselves exist. Before attempting either reviewed migration, run the following **SELECT-only** catalog query using the existing FadeHost database Console. It returns structural metadata only and cannot alter production data:

```sql
SELECT t.table_name,
       CASE WHEN c.oid IS NULL THEN 'missing' ELSE 'present' END AS table_status,
       COALESCE(a.attname, '(table only)') AS column_name,
       CASE WHEN a.attnum IS NULL THEN NULL
            ELSE format_type(a.atttypid,a.atttypmod) END AS column_type,
       CASE WHEN a.attnum IS NULL THEN NULL ELSE a.attnotnull END AS not_null
FROM (VALUES
  ('users','id'),
  ('wallets','id'),
  ('wallets','chain_id'),
  ('wallets','wallet_address'),
  ('wallets','is_platform_controlled'),
  ('user_wallet_assignments','user_id'),
  ('user_wallet_assignments','wallet_id'),
  ('verified_deposit_evidence','event_key'),
  ('deposit_address_ownership_history','wallet_id')
) AS t(table_name,expected_column)
LEFT JOIN pg_namespace n ON n.nspname='public'
LEFT JOIN pg_class c ON c.relnamespace=n.oid
  AND c.relname=t.table_name AND c.relkind IN ('r','p')
LEFT JOIN pg_attribute a ON a.attrelid=c.oid
  AND a.attname=t.expected_column AND a.attnum>0 AND NOT a.attisdropped
ORDER BY t.table_name,t.expected_column;
```

Interpretation: `users.id`, `wallets.id`, `wallets.chain_id`, and `user_wallet_assignments.user_id/wallet_id` must match their reviewed FK types (`bigint` for IDs); `wallets.chain_id` is `integer` in production and the proposed history `chain_id` is now `integer` too. A mismatch means **revise the reviewed migration in a new PR and retest**, not cast or alter existing production columns. This query is diagnostic only; do not run `CREATE`, `ALTER`, `RESTORE`, `DELETE`, or `GRANT` from this checklist.

The result does not waive the independent production backup-restore, security/accounting sign-off, or owner approval requirements.

## 8. Observed production type preflight — 2026-11-23 13:55 UTC

The live Super Admin report confirmed `wallets.chain_id` is **integer**, not the `bigint` assumed by the reviewed ownership migration. **Do not execute that migration as written.** PostgreSQL can compare integer and bigint values, but the reviewed contract, audit expectations, and production DDL must be reconciled and tested against the actual catalog first. Do not alter the existing wallet column to fit a proposed migration.

The report also said `users.id` was `missing`. **This is a diagnostic coverage defect, not proof that the column is absent:** the deployed metadata query only selects tables in its `required` map, and `users` is absent from that map. Add `users: ['id']` to the metadata query and rerun before deciding the actual FK type. Do not infer a production schema defect from that false negative.

Status: production structure incomplete; historical ownership migration **blocked**, no DDL or financial activation authorized.

## 9. Production recheck — 2026-11-23 14:37 UTC

The corrected read-only startup audit now includes `users.id` in its catalog scope. Its report has **no `users.id` mismatch**, confirming the previous `missing` diagnostic was a false negative. It still reports `wallets.chain_id` as PostgreSQL `integer`. The draft ownership-history migration and its catalog audit have therefore been changed to `integer` for the history chain ID and wallet chain ID type expectation. No existing production column was modified.

The current PR #114 head passed all four CI suites after those changes. The live production schema is still structurally incomplete (missing evidence/history tables); passing CI is **not** authorization to execute either review-only migration. Actual FadeHost backup restoration, independent historical ownership and chain-finality verification, accounting/security review, and explicit owner approval remain outstanding.
