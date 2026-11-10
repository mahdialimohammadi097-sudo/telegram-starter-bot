# PROFINO Ledger Safety Audit

**Date:** 2026-11-10  
**Revision reviewed:** `4b0941276263fb12b512820a33754997b4e9e909`  
**Method:** Static repository inspection only. No production database connection, schema mutation, deposit, withdrawal, or transfer was performed.

## What the current code proves

- The wallet query aggregates ledger entries only when their parent `ledger_transactions.status = 'posted'`.
- The wallet expects three USDT account types: `AVAILABLE`, `INVESTED`, and `PROFIT`; it fails closed if any expected account is missing.
- The wallet previously converted PostgreSQL numeric values through JavaScript `Number`, which can lose decimal precision. The wallet now formats numeric strings using integer arithmetic and eight decimal places.
- Deposit UI explicitly says automatic verification is disabled and warns users not to send funds until an official address is shown.
- Withdrawal UI explicitly says withdrawals are disabled.

## What is not implemented or not evidenced in this repository

- No ledger schema migration or DDL is present in the repository tree for `ledger_accounts`, `ledger_transactions`, or `ledger_entries`. The schema diagnostics can inspect these tables if they exist, but cannot prove the live database has the required structure.
- No production ledger-posting service was found that atomically writes balanced debit/credit entries and transitions a transaction to `posted`.
- No verified idempotency-key enforcement, duplicate deposit protection, immutable journal enforcement, reversal workflow, or reconciliation job was found.
- No transaction-level check was found that prevents an `AVAILABLE` account from becoming negative.
- The balance query is a display read model; it is not a financial control and must not be treated as authorization to withdraw or invest.
- Investment, deposit, withdrawal, profit accrual/distribution, and referral reward execution remain disabled or placeholders in the customer flow.

## Safe code improvements in this revision

- Added exact eight-decimal USDT formatting using `BigInt`-based integer units; wallet display no longer converts database numeric strings to floating-point values.
- Added pure ledger invariant helpers and unit tests for balanced entries, positive amounts, currency grouping, and non-negative available-balance checks. These are validation primitives only; they do not create or post ledger transactions.

## Release blockers before real funds

1. Obtain a read-only snapshot of the actual production schema and verify columns, precision, foreign keys, unique constraints, indexes, and triggers.
2. Add versioned migrations for the ledger schema, including a documented account model and transaction state machine.
3. Implement a single atomic posting service with per-currency debit/credit equality, unique idempotency keys, row-level locking, and no-negative-available-balance enforcement.
4. Make posted journal rows immutable; corrections must use compensating/reversal entries with audit records.
5. Add integration tests against a disposable PostgreSQL database, including concurrency, duplicate requests, rollback, and reconciliation.
6. Complete legal, custody, sanctions/AML, and operational review before enabling deposits, withdrawals, investment allocations, or live arbitrage.

**Conclusion:** The current code can display posted-ledger balances, but it is not yet a complete or production-safe financial ledger. No real-money workflow should be enabled on the basis of the current wallet screen or these helper tests.
