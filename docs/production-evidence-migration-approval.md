# PROFINO — production evidence migration approval gate

Status: PREPARATION ONLY. No production DDL authorization. No live deposit activation.

## Historical observations (2026-11-21; not current readiness evidence)
- FadeHost database `profino-db` is PostgreSQL 17, private-only.
- Read-only `SELECT to_regclass('public.verified_deposit_evidence')` returned NULL: table absent.
- Four encrypted snapshot entries were visible in FadeHost UI. A new snapshot was recorded on 1405/08/30 16:06:13 (displayed local time), snapshot ID `91d63c6c`, size 129.1 KB. Its recoverability has **not** been tested. Do not treat the presence of Restore as proof of recovery.
- PR #80 candidate SQL: `migrations/20261121_verified_deposit_evidence.sql`.
- The three PR #80 GitHub workflows passed at commit `93238931798d607af23dff7166db617d0d85a9bc`. CI uses disposable PostgreSQL and does not prove live restore.

## Operator preflight (read-only)
1. Verify target is exactly the existing `profino-db` private PostgreSQL 17 database; never turn public access on.
2. Review the current integration candidate `migrations/20261121_verified_deposit_evidence.sql`, including the #200 precision correction. PR #80 is historical, not an execution reference. Confirm create-only scope, constraints and transaction guards. Record the exact approved commit SHA; require successful CI on that revision.
3. Use the FadeHost database console only for read-only inspection:
   `SELECT current_database(), current_setting('server_version') AS pg_version, to_regclass('public.verified_deposit_evidence') AS evidence_table;`
4. **Completed:** a new FadeHost snapshot `91d63c6c` appeared in the list. Before any approved execution, reconfirm that this snapshot still exists and that its timestamp predates the migration. Do not click Restore or Delete on the production database.
5. Verify recovery on an isolated restore target with actual production backup evidence and reconciliation. Provider documentation and disposable synthetic restore tests are not proof of production recoverability. If no safe restore target is available, mark restore verification as BLOCKED; do not restore over production.
6. Obtain explicit separate owner approval for applying the exact candidate migration to production after steps 1–5. The approval for preparation is not approval to execute.

## Production execution — NOT AUTHORIZED
Only after explicit approval, in an authorized private-network SQL execution session, execute the reviewed create-only migration once with bounded lock and statement timeouts. If the relation already exists or execution outcome is uncertain, stop and inspect the catalog read-only; do not retry or drop the existing relation. Do not use automated deployment or bot startup to apply DDL.

## Post-execution verification (read-only; only after separately approved execution)
- Run the full reviewed read-only catalog audit `npm run audit:deposit-schema -- --include-legacy-assignments` via an authorized private-network execution path; the legacy `scripts/fadehost-schema-audit.js` alone is insufficient. If execution is restricted to a paid plan, leave the live audit blocked; do not bypass the restriction.
- Inspect permanent standalone relation type, column nullability, unconstrained numeric evidence fields with validated scale-zero and uint256 bounds, and live immediate unique event-key index. A numeric(78,0) typmod silently rounds fractional inputs and is no longer compatible.
- Verify existing ledger totals and bot health unchanged.
- Record results and halt if any discrepancy occurs. No automatic rollback or destructive restore without separate incident review.

## Scope limits
This migration creates evidence storage only. It does not verify on-chain transfers, allocate deposit addresses, credit ledger balances, accept deposits, or authorize withdrawals. Those require independent security/accounting sign-off and separate explicit owner approval.
