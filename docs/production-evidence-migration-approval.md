# PROFINO — production evidence migration approval gate

Status: PREPARATION ONLY. No production DDL authorization. No live deposit activation.

## Verified facts (2026-11-21)
- FadeHost database `profino-db` is PostgreSQL 17, private-only.
- Read-only `SELECT to_regclass('public.verified_deposit_evidence')` returned NULL: table absent.
- Four encrypted snapshot entries were visible in FadeHost UI. A new snapshot was recorded on 1405/08/30 16:06:13 (displayed local time), snapshot ID `91d63c6c`, size 129.1 KB. Its recoverability has **not** been tested. Do not treat the presence of Restore as proof of recovery.
- PR #80 candidate SQL: `migrations/20261121_verified_deposit_evidence.sql`.
- The three PR #80 GitHub workflows passed at commit `93238931798d607af23dff7166db617d0d85a9bc`. CI uses disposable PostgreSQL and does not prove live restore.

## Operator preflight (read-only)
1. Verify target is exactly the existing `profino-db` private PostgreSQL 17 database; never turn public access on.
2. Inspect candidate SQL in PR #80 and confirm it contains only the expected CREATE TABLE, constraints and transaction guards. Record the exact commit SHA; rerun CI after any edit.
3. Use the FadeHost database console only for read-only inspection:
   `SELECT current_database(), current_setting('server_version') AS pg_version, to_regclass('public.verified_deposit_evidence') AS evidence_table;`
4. **Completed:** a new FadeHost snapshot `91d63c6c` appeared in the list. Before any approved execution, reconfirm that this snapshot still exists and that its timestamp predates the migration. Do not click Restore or Delete on the production database.
5. Establish an isolated restore target or obtain documented confirmation of recovery procedure from FadeHost. If no safe restore target is available, mark restore verification as BLOCKED; do not restore over production.
6. Obtain explicit separate owner approval for applying the exact candidate migration to production after steps 1–5. The approval for preparation is not approval to execute.

## Production execution — NOT AUTHORIZED
Only after explicit approval, in an authorized private-network SQL execution session, execute the reviewed migration once with bounded lock and statement timeouts. Do not use automated deployment or bot startup to apply DDL.

## Post-execution verification (read-only; only after separately approved execution)
- Re-run `node scripts/fadehost-schema-audit.js` as a one-off private-network command, not a recurring schedule.
- Inspect column nullability, numeric(78,0), event-key unique index and constraints.
- Verify existing ledger totals and bot health unchanged.
- Record results and halt if any discrepancy occurs. No automatic rollback or destructive restore without separate incident review.

## Scope limits
This migration creates evidence storage only. It does not verify on-chain transfers, allocate deposit addresses, credit ledger balances, accept deposits, or authorize withdrawals. Those require independent security/accounting sign-off and separate explicit owner approval.
