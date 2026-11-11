# PROFINO Ledger Safety Audit

**Date:** 2026-11-11
**Revision reviewed:** `aeefcc9f2b94e54f164b9e3af89ff7e10a10b89f`
**Method:** Static repository inspection plus review of previously supplied read-only aggregate inventory output. No production schema mutation, deposit, withdrawal, or transfer was performed. This audit did not retrieve or inspect a complete production DDL/schema snapshot.

## Subsequent verification on the integrated review branch

PR #49 recorded ledger table definitions and enabled trigger functions from the production catalog. Its isolated tests fixed numeric-scale handling. PR #50 tested synthetic deposit approval and the wallet balance reader. PR #51 combines these changes with the financial diagnostics and security branches. A BSC testnet receipt was read from one RPC endpoint and checked against a second endpoint. No private key or transfer was required. The offline suite compares the captured chain, transaction, block, token, recipient, log index and exact amount. The assigned test wallet and ledger entries are synthetic.

Independent reconciliation in the test schema detects an approved claim missing a posted journal, a journal without an approved claim, and a mismatched amount. Live deposit attribution, reconciliation against external custody balances, reversals and payout operations still require separate implementation and verification. [Integrated test evidence](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/43093073210).

## What the current code proves

- The wallet query aggregates ledger entries only when their parent `ledger_transactions.status = 'posted'`.
- The wallet expects three USDT account types: `AVAILABLE`, `INVESTED`, and `PROFIT`; it fails closed if any expected account is missing.
- The wallet previously converted PostgreSQL numeric values through JavaScript `Number`, which can lose decimal precision. The wallet now formats numeric strings using integer arithmetic and eight decimal places.
- Deposit UI explicitly says automatic verification is disabled and warns users not to send funds until an official address is shown.
- Withdrawal UI explicitly says withdrawals are disabled.

## Subsequent isolated-branch evidence (not merged into main)

The following work was added after the revision audited above. It is evidence of a development foundation only; it does not change the audit conclusion for the current `main` branch and does not authorize production use.

- Draft PR [#35](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/pull/35) adds an isolated PostgreSQL ledger-posting service with exact eight-decimal USDT normalization, balanced journal validation, transaction-scoped idempotency locking, account-row locking, and rollback handling. It now discards the client if rollback itself fails. Latest CI run #42975311041 passed 43/43 unit tests, 0 failed, 0 skipped. It is not wired to Telegram/customer actions.
- Draft PR [#36](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/pull/36) adds disposable PostgreSQL 17 integration tests using a per-run temporary schema. After incorporating the current PR #35 head, CI run #42975463597 passed 46/46 tests on PostgreSQL 17.11, 0 failed, 0 skipped. Database-backed cases cover concurrent identical idempotency, competing AVAILABLE debits and full rollback after an injected trigger failure.
- Draft PR [#42](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/pull/42), chained on PR #36, extends the disposable PostgreSQL 17 suite with database-trigger tests that reject unbalanced posting and appending entries to posted journals. CI run [#42981361057](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/42981361057) passed 51/51 tests, 0 failed. It also exercises deferred constraint failure at COMMIT, rollback, UPDATE/DELETE immutability and concurrent idempotency-key mismatch. These use synthetic test triggers and do not verify FadeHost production trigger definitions.
- GitHub Actions run [#239](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/42914533133) passed on PR #36 head `5e5cc5579666090b8e98a91bd9804d2d1bdfc0e1`. The job initialized the PostgreSQL service, installed dependencies, checked JavaScript syntax, and ran `npm test`. The PR reports 43 tests passed, 0 failed, 0 skipped; the two PostgreSQL concurrency cases executed rather than being skipped.
- The integration schema is deliberately minimal. It does not reproduce the actual FadeHost production schema, all deferred trigger/function bodies, every production constraint, or immutable-posting rules. Therefore these CI results are not production-schema verification.
- Draft PR #31 now extends the read-only diagnostic to report numeric precision/scale, identity metadata, constraint deferrability/validation, and trigger enabled/deferrable state. Its disposable PostgreSQL 17.11 diagnostic integration test passed as part of run #42975417324 (36/36 tests). The actual production `/dbschema` output is still required.
- Draft PR [#45](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/pull/45), chained on PR #31, carries command/post-management/post-history/scheduler diagnostic sanitization while preserving PR #31's command additions and helper. CI run [#42984567942](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/42984567942) passed 40/40 tests, 0 failed, 0 skipped. Draft PR [#46](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/pull/46), chained on #45, extends sanitization to startup/runtime entry-point logs; CI run [#42984646202](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/42984646202) also passed 40/40, 0 failed, 0 skipped. Earlier overlapping PRs #40 and #44 were closed as superseded; neither was merged. PRs #45 and #46 remain draft and unmerged.

## Production database evidence boundary

A prior read-only diagnostic reported 9/9 expected core tables, 24 total tables, 68 indexes and 16 user-defined triggers. An earlier manual table listing counted 25 tables; the count discrepancy has not been reconciled. The diagnostic exposed aggregate inventory only. No complete production table definitions, column types/precision, foreign-key and unique-constraint definitions, deferred constraints, trigger definitions, or trigger-function bodies were captured for this audit. Therefore, the existence/count of core objects must not be described as verification of their financial semantics or correctness.

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

1. Obtain and reconcile a complete read-only snapshot of the actual production schema; verify columns, numeric precision, foreign keys, unique constraints, indexes, deferred constraints, trigger definitions, and trigger-function bodies. The aggregate inventory above is insufficient.
2. Reconcile the draft ledger foundation with the exact production DDL and deferred trigger/function definitions; add migrations only after an independently reviewed schema design.
3. Verify production idempotency, transaction rollback, concurrent duplicate requests, concurrent available-balance debits, and immutable posted-row behavior against the real schema contract in a disposable database.
4. Make posted journal rows immutable; corrections must use compensating/reversal entries with audit records.
5. Add reconciliation and operational recovery procedures, then test them independently.
6. Complete legal, custody, sanctions/AML, and operational review before enabling deposits, withdrawals, investment allocations, or other real-funds flows.

**Conclusion:** The current main branch can display posted-ledger balances and contains validation helpers, but it is not a complete or production-safe financial ledger. Draft PRs #35 and #36 are useful isolated development work, not production approval. No real-money workflow should be enabled on the basis of the wallet screen, mocked tests, or the minimal-schema PostgreSQL integration suite.
