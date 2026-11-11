# Ledger Posting Foundation — Engineering Notes

**Status:** Isolated, non-production implementation foundation  
**Currency:** USDT only  
**Precision:** Exact integer units at 8 decimal places

## Implemented in this branch

- Normalizes ledger entry amounts without floating-point arithmetic.
- Rejects unsupported currencies, invalid account IDs, non-positive amounts, unbalanced journals, and precision beyond eight decimals.
- Uses one PostgreSQL transaction for the journal lifecycle.
- Serializes requests sharing an idempotency key with a transaction-scoped advisory lock.
- Replays an identical already-posted request as an idempotent success; rejects key reuse with different metadata or entries.
- Locks all affected account rows in ascending ID order before checking available balances.
- Enforces a non-negative projected balance for accounts whose `account_type` is `AVAILABLE`.
- Inserts the transaction as pending, inserts entries, then transitions it to posted before commit; any failure rolls back.
- Does not wire posting into Telegram customer flows or activate any money movement.

## Database contract assumed by this module

The module relies on the existing production schema shape previously reported by the owner:
- `ledger_accounts(id, account_type, currency)`
- `ledger_transactions(id, transaction_type, reference_id, idempotency_key, description, status)`
- `ledger_entries(id, transaction_id, account_id, entry_type, amount, currency)`

The exact production trigger/function bodies, all column nullability/defaults, and lock/trigger interaction have not yet been re-verified. The module must therefore remain isolated until a read-only schema report and disposable-PostgreSQL integration tests confirm this contract.

## Verification completed on 2026-11-11

- GitHub Actions run #42975463597 executed 46 tests against PostgreSQL 17.11: 46 passed, 0 failed, 0 skipped. The branch includes the latest PR #35 posting implementation and its rollback-failure client-discard regression test.
- Three database-backed cases cover concurrent identical idempotency-key requests, concurrent `AVAILABLE` debits, and whole-journal rollback after an injected trigger failure.
- Each run uses a temporary isolated schema. The test DDL is intentionally minimal and is not claimed to match the actual FadeHost production schema or its trigger/function definitions.

## Remaining mandatory verification

1. Obtain the complete current `/dbschema` output for the three ledger tables and all trigger/function definitions.
2. Extend the disposable PostgreSQL 17 integration tests to use the exact verified constraints and triggers once a read-only production schema report is available.
3. Test concurrent duplicate idempotency keys, concurrent available-balance debits, rollback, deferred trigger failures, and immutable posted rows.
4. Add a request-hash column or durable request fingerprint only if the verified schema/design requires it; current duplicate detection compares the complete normalized metadata and journal entries.
5. Obtain independent review before any caller is allowed to use this service for customer funds.

**Production restriction:** No deployment, migration, live balance update, customer posting, deposit, withdrawal, investment, or profit distribution is authorized by this implementation.
