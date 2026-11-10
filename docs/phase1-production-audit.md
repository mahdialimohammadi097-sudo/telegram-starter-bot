# PROFINO Phase 1 Production Audit

**Audit date:** 2026-11-10  
**Audited revision:** `d08731326624653347b148cc07d85c80c0c5ad61`  
**Working branch:** `feature/phase1-production-audit`

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

### Live schema review (owner-provided `/dbschema` output)
1. The production database contains the expected core domains: users/admin, ledger accounts/entries/transactions, investments/plans, profit records, deposits/withdrawals, referrals, reserve wallets/snapshots, wallet assignments/transfers/approvals, and scheduled-post history.
2. `users.telegram_id` and `users.referral_code` are unique; user status is constrained to `active`, `blocked`, or `pending`; referral self-reference is protected by a foreign key.
3. Ledger transactions have constrained statuses (`pending`, `posted`, `reversed`), unique idempotency keys, and a deferred balance trigger. Ledger entries enforce positive amounts, `debit`/`credit` types, foreign keys, and a deferred balance trigger.
4. Profit records enforce positive USDT amounts, valid statuses, approval-field consistency, and one record per investment per date.
5. `admin_audit_logs` retains a legacy-compatible `admin_user_id` column and newer actor/details fields. The current source writes both `admin_user_id` and `actor_telegram_id`, so the observed `admin_user_id NOT NULL` constraint is compatible with the current insert path, provided the acting Telegram account has an active `admin_users` row.
6. The schema output confirms many useful indexes, including ledger transaction lookup, user investment lookup, pending profit lookup, due scheduled posts, and unique active wallet assignment per user/type.

### Important limitations / open verification
1. The supplied output lists all tables but only includes full column/constraint detail for selected tables. Full definitions for `deposit_requests`, `withdrawal_requests`, `investment_plans`, `investment_plan_versions`, `investments`, `wallets`, `wallet_transfers`, `wallet_transfer_approvals`, `reserve_wallets`, `reserve_balance_snapshots`, and `referrals` are still needed before those workflows can be assessed.
2. The output identifies deferred ledger triggers but does not include their function bodies or full trigger definitions. We must inspect those definitions to confirm exactly when and how balance is enforced.
3. The `admin_audit_logs.admin_user_id` foreign key references `admin_users(user_id)`. Confirm that the actual Super Admin is present and active in `admin_users`; otherwise audit writes can fail even though the Telegram ID is recognized elsewhere.
4. Schema presence does not prove application-level workflows are complete or safe. The current wallet screen is a read-only balance view; no complete deposit, withdrawal, investment, or profit lifecycle is implemented.
5. Referral code generation exists, but referral attribution and rewards remain placeholders.
6. No exchange-connected arbitrage engine or order lifecycle is implemented.
7. The original shared amount parser rounded inputs beyond eight decimal places. A branch-only fix now separates display rounding from exact financial validation: `formatUsdt()` may round for display, while ledger invariant and available-balance helpers reject inputs exceeding eight decimal places. New unit tests cover this boundary. This remains a helper-level safeguard, not a production posting service.
8. User registration currently creates new accounts with status `active`; there is no pending/manual approval step in the `/start` path. Existing blocked/pending accounts are not automatically reactivated by the upsert, but the onboarding policy should be explicitly decided.
9. Rate limiting is process-local and stored in memory. It is not shared across multiple bot replicas and resets on restart; it is a useful basic throttle, not a distributed abuse-control system.
10. Scheduled-post processing uses database row claims with `FOR UPDATE SKIP LOCKED`, which is a useful concurrency safeguard. However, startup recovery changes every `preview_sending` and `publishing` row to an unknown state; in a multi-instance deployment this could incorrectly mark another live instance's in-flight operation as uncertain. Deployment should remain single-instance until recovery is made lease/heartbeat-aware.
11. Post-edit and restore conversations use in-memory Maps. Sessions are lost on restart and are not shared across replicas; persistent admin workflow sessions would be needed for robust multi-instance operation.
2. The current wallet screen is a read-only balance view; no complete deposit, withdrawal, investment, or profit lifecycle is implemented.
3. Referral code generation exists, but referral attribution and rewards remain placeholders.
4. The repository has no implemented exchange-connected arbitrage engine or order lifecycle.
5. No real-funds workflow should be enabled until database invariants, atomic posting, idempotency, reconciliation, authorization, operational controls, and applicable legal requirements have been reviewed.

## Next actions

1. Obtain full schema details for the remaining financial and wallet tables, plus the definitions of the deferred ledger triggers and their trigger functions.
2. Verify the Super Admin has an active `admin_users` row so audit writes satisfy the production foreign key.
3. Trace every ledger read and write path; confirm transaction atomicity, immutable posting, idempotency, and reversal controls.
4. Decide whether USDT values with more than eight decimal places should be rejected; add explicit tests either way.
5. Add disposable-PostgreSQL integration tests for schema migrations and ledger invariants. The current branch adds unit coverage for strict eight-decimal financial validation; PostgreSQL concurrency and trigger behavior remain untested.
6. Keep deposits, withdrawals, investment execution, profit distribution, and live arbitrage disabled until independently reviewed and explicitly authorized.

## Release boundary

This branch is for audit and safe development only. It must not be merged or deployed without a separate explicit approval. No production secrets are requested or stored in this document.
