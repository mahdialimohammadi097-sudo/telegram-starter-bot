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

## Mandatory next verification

1. Obtain the complete current `/dbschema` output for the three ledger tables and all trigger/function definitions.
2. Run integration tests against a disposable PostgreSQL 17 database with the exact constraints and triggers.
3. Test concurrent duplicate idempotency keys, concurrent available-balance debits, rollback, deferred trigger failures, and immutable posted rows.
4. Add a request-hash column or durable request fingerprint only if the verified schema/design requires it; current duplicate detection compares the complete normalized metadata and journal entries.
5. Obtain independent review before any caller is allowed to use this service for customer funds.

**Production restriction:** No deployment, migration, live balance update, customer posting, deposit, withdrawal, investment, or profit distribution is authorized by this implementation.
