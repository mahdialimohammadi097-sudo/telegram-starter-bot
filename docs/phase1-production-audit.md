# PROFINO Phase 1 Production Audit

**Audit date:** 2026-11-10  
**Audited revision:** `d08731326624653347b148cc07d85c80c0c5ad61`  
**Merged revision:** `f48e6c330bf2319095e3f7630ebb3a9c3df5a1c1` (PR #29)

## Scope and evidence

This is a read-only source and deployment-evidence review. No production database rows, balances, deposits, withdrawals, or customer funds were changed.

Verified evidence available for this review:
- FadeHost deployment log for the audited revision reports PostgreSQL connected, admin and post-history schemas initialized, Telegram authenticated as `@PROFINO1bot`, and polling active.
- The production `/start` interaction has been confirmed by the owner.
- External monitor run `42865030746` recovered the service and observed `/healthz` and `/` returning HTTP 200.
- CI run `42865030919` completed JavaScript syntax checks and `npm test` successfully.
- The current source includes USDT fixed-point helpers, balanced-ledger validation helpers, owner-only admin operations, private-chat enforcement, rate limiting, and approval-gated scheduled publishing.

## Findings

### Confirmed strengths
1. Customer-facing menu and messages in the reviewed command module are English.
2. Admin language preference is stored against the internal `users.id`, resolved from the administrator's Telegram ID; the preference table has a foreign key to `users(id)`.
3. Wallet display includes only ledger entries whose parent transaction is `posted`.
4. Deposit and withdrawal screens explicitly state that those services are not enabled.
5. Scheduled channel posts require an explicit administrator approval before publication.
6. Core schema diagnostics are read-only and restricted to the Super Admin's private chat.
7. Ledger helper tests cover eight-decimal precision, per-currency balancing, invalid amounts, and overdraft rejection.

### Production schema output — not independently verified

A previous draft of this audit described detailed table and constraint findings as if the owner-provided `/dbschema` output were available. The raw output is not present in the current audit materials, so those detailed assertions cannot be independently substantiated and must not be treated as verified production facts.

Prior conversation notes report read-only aggregate checks of 9/9 expected core tables, 24 total tables, 68 indexes and 16 user-defined triggers; a separate manual listing counted 25 tables. The raw output is unavailable and the count discrepancy is unresolved. These historical aggregate notes do not establish exact table definitions or financial behavior.

The repository's `src/database-diagnostics.js` contains read-only queries intended to report the 25 expected core table names, columns, constraints, indexes, trigger definitions and trigger-function bodies. This demonstrates diagnostic capability in source code only; it does not prove that the command completed successfully against the current production database or that all expected objects exist.

### Important limitations / open verification
1. The supplied production output listed all tables but only included full column/constraint detail for selected tables. The branch now expands the read-only diagnostic to cover all 25 known tables; those diagnostic results can now be collected after the FadeHost deployment completes.
2. The output identifies deferred ledger triggers but does not include their function bodies or full trigger definitions. We must inspect those definitions to confirm exactly when and how balance is enforced.
3. The `admin_audit_logs.admin_user_id` foreign key references `admin_users(user_id)`. Confirm that the actual Super Admin is present and active in `admin_users`; otherwise audit writes can fail even though the Telegram ID is recognized elsewhere.
4. Schema presence does not prove application-level workflows are complete or safe. The current wallet screen is a read-only balance view; no complete deposit, withdrawal, investment, or profit lifecycle is implemented.
5. Referral code generation exists, but referral attribution and rewards remain placeholders.
6. The original shared amount parser rounded inputs beyond eight decimal places. A branch-only fix now separates display rounding from exact financial validation: `formatUsdt()` may round for display, while ledger invariant and available-balance helpers reject inputs exceeding eight decimal places. New unit tests cover this boundary. This remains a helper-level safeguard, not a production posting service.
7. User registration currently creates new accounts with status `active`; there is no pending/manual approval step in the `/start` path. Existing blocked/pending accounts are not automatically reactivated by the upsert, but the onboarding policy should be explicitly decided.
8. Rate limiting is process-local and stored in memory. It is not shared across multiple bot replicas and resets on restart; it is a useful basic throttle, not a distributed abuse-control system.
9. Scheduled-post processing uses database row claims with `FOR UPDATE SKIP LOCKED`, which is a useful concurrency safeguard. However, startup recovery changes every `preview_sending` and `publishing` row to an unknown state; in a multi-instance deployment this could incorrectly mark another live instance's in-flight operation as uncertain. Deployment should remain single-instance until recovery is made lease/heartbeat-aware.
10. Post-edit and restore conversations use in-memory Maps. Sessions are lost on restart and are not shared across replicas; persistent admin workflow sessions would be needed for robust multi-instance operation.

## Next actions

1. Run the read-only `/dbschema` command against the current FadeHost database and preserve the complete output, including all `TABLE`, `COLUMNS`, `CONSTRAINTS`, `DATABASE INDEXES`, and `DATABASE TRIGGERS` sections. The source diagnostic is designed to report 25 expected core table names, but actual production results have not been captured in this audit.
2. From the returned schema and a separate read-only membership check, verify the Super Admin has an active `admin_users` row so audit writes satisfy the production foreign key.
3. Trace every ledger read and write path; confirm transaction atomicity, immutable posting, idempotency, and reversal controls.
4. Decide whether USDT values with more than eight decimal places should be rejected; add explicit tests either way.
5. Add disposable-PostgreSQL integration tests for schema migrations and ledger invariants. The current branch adds unit coverage for strict eight-decimal financial validation; PostgreSQL concurrency and trigger behavior remain untested.
6. Keep deposits, withdrawals, investment execution, and profit distribution disabled until independently reviewed and explicitly authorized.

## Release boundary

PR #29 has been merged with owner approval. This document does not authorize any financial workflow or further deployment. No production secrets are requested or stored in this document.
