# PROFINO Ledger Safety Audit

**Date:** 2026-11-10  
**Revision reviewed:** `516730193d3c60ec91736a9d1e1ca37167abf283`  
**Method:** Static repository inspection only. No production database connection, schema mutation, deposit, withdrawal, or transfer was performed.

## What the current code proves

- The wallet query aggregates ledger entries only when their parent `ledger_transactions.status = 'posted'`.
- The wallet expects three USDT account types: `AVAILABLE`, `INVESTED`, and `PROFIT`; it fails closed if any expected account is missing.
- The wallet previously converted PostgreSQL numeric values through JavaScript `Number`, which can lose decimal precision. The wallet now formats numeric strings using integer arithmetic and eight decimal places.
- Deposit UI explicitly says automatic verification is disabled and warns users not to send funds until an official address is shown.
- Withdrawal UI explicitly says withdrawals are disabled.

## Subsequent isolated-branch evidence (not merged into main)

The following work was added after the revision audited above. It is evidence of a development foundation only; it does not change the audit conclusion for the current `main` branch and does not authorize production use.

- Draft PR [#35](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/pull/35) adds an isolated PostgreSQL ledger-posting service with exact eight-decimal USDT normalization, balanced journal validation, transaction-scoped idempotency locking, account-row locking, and rollback handling. It is not wired to Telegram/customer actions.
- Draft PR [#36](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/pull/36) adds disposable PostgreSQL 17 integration tests using a per-run temporary schema.
- GitHub Actions run [#239](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/42914533133) passed on PR #36 head `5e5cc5579666090b8e98a91bd9804d2d1bdfc0e1`. The job initialized the PostgreSQL service, installed dependencies, checked JavaScript syntax, and ran `npm test`. The PR reports 43 tests passed, 0 failed, 0 skipped; the two PostgreSQL concurrency cases executed rather than being skipped.
- The integration schema is deliberately minimal. It does not reproduce the actual FadeHost production schema, deferred trigger/function bodies, all production constraints, or immutable-posting rules. Therefore this CI result is not production-schema verification.

## What is not implemented or not evidenced in the current main branch

- No ledger schema migration or DDL is present in the repository tree for `ledger_accounts`, `ledger_transactions`, or `ledger_entries`. The schema diagnostics can inspect these tables if they exist, but cannot prove the live database has the required structure.
- No ledger-posting service is merged into the current `main` branch. The service in draft PR #35 remains isolated and is not production-enabled.
- No verified production idempotency enforcement, duplicate deposit protection, immutable journal enforcement, reversal workflow, or reconciliation job is available in the current main branch.
- No production-verified transaction-level control is evidenced that prevents an `AVAILABLE` account from becoming negative.
- The balance query is a display read model; it is not a financial control and must not be treated as authorization to withdraw or invest.
- Investment, deposit, withdrawal, profit accrual/distribution, and referral reward execution remain disabled or placeholders in the customer flow.

## Safe code improvements in the audited revision

- Added exact eight-decimal USDT formatting using `BigInt`-based integer units; wallet display no longer converts database numeric strings to floating-point values.
- Added pure ledger invariant helpers and unit tests for balanced entries, positive amounts, currency grouping, and non-negative available-balance checks. These are validation primitives only; they do not create or post ledger transactions.

## Release blockers before real funds

1. Obtain a read-only snapshot of the actual production schema and verify columns, precision, foreign keys, unique constraints, indexes, and triggers.
2. Reconcile the draft ledger foundation with the exact production DDL and deferred trigger/function definitions; add migrations only after an independently reviewed schema design.
3. Verify production idempotency, transaction rollback, concurrent duplicate requests, concurrent available-balance debits, and immutable posted-row behavior against the real schema contract in a disposable database.
4. Make posted journal rows immutable; corrections must use compensating/reversal entries with audit records.
5. Add reconciliation and operational recovery procedures, then test them independently.
6. Complete legal, custody, sanctions/AML, and operational review before enabling deposits, withdrawals, investment allocations, or other real-funds flows.

**Conclusion:** The current main branch can display posted-ledger balances and contains validation helpers, but it is not a complete or production-safe financial ledger. Draft PRs #35 and #36 are useful isolated development work, not production approval. No real-money workflow should be enabled on the basis of the wallet screen, mocked tests, or the minimal-schema PostgreSQL integration suite.
