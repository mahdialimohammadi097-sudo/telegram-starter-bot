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
