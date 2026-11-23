# PROFINO — live USDT activation blockers (NOT APPROVED)

This review covers the integrated **read-only** deposit preflight and evidence-table migration in draft PR #114. Passing CI is not a production authorization.

## Verified from the reviewed code

- `scripts/deposit-preflight.js` opens a repeatable-read, read-only transaction, inspects schema and active deposit wallet uniqueness, then rolls back.
- `src/deposit-schema-audit.js` checks required columns, numeric precision, validated foreign keys, selected unique indexes and selected CHECK constraint patterns. Regex matching is **not** a proof of logical equivalence of PostgreSQL expressions.
- `migrations/20261123_verified_deposit_evidence.review.sql` proposes additive evidence storage only; it does not implement chain monitoring, deposit crediting, or withdrawals.
- CI PostgreSQL restore drills use disposable CI databases. They do **not** prove that the actual FadeHost production database backup can be restored.

## Mandatory evidence still required before any live deposit

1. **Production backup:** independently verify a recent encrypted FadeHost production backup and successfully restore it to an isolated nonproduction PostgreSQL 17 target. Capture sanitized timestamps, versions, and success/failure; never expose secrets or user records.
2. **Production catalog:** run the original read-only FadeHost schema audit and stronger deposit preflight using a dedicated least-privilege read-only role. Review actual SQL definitions, index predicates, and privilege grants manually.
3. **Chain evidence:** independently test the selected USDT token contract and chain ID, event identity, confirmations/reorg handling, event replay, mismatched deposit addresses, wrong tokens, malformed amounts, and RPC outage recovery. Do not enable a listener or crediting handler for this review.
4. **Accounting:** demonstrate atomic, balanced double-entry postings; exact USDT base-unit conversion; idempotent transaction keys; duplicate-event and concurrency rejection; failed-posting rollback; no negative available balances; and reconciliation against independently verified chain evidence. The current ledger parser uses **8 decimal places** (`src/ledger-safety.js`); independently verify the configured chain token's actual `decimals` and implement/test a lossless integer conversion between on-chain `amount_base_units` and ledger units before any credit. Never assume the token uses 8 decimals, never round deposits, and reject unsupported precision or mismatched token contracts.
5. **Authorization:** demonstrate admin authentication and least privilege, explicit approval boundaries, audit trail integrity, safe handling of credentials, and operational monitoring. Ensure a successful schema check cannot turn on deposits.
6. **Operations:** record reviewed deployment SHA, tested release/rollback procedure, alerting and incident response. Production migration requires **separate owner authorization** and a controlled maintenance window; financial activation requires a second explicit owner authorization after security/accounting sign-off.

## Release decision

**BLOCKED** until all six gates are independently evidenced and the owner explicitly authorizes the appropriate action. No merging to `main`, no production schema writes, no live deposit acceptance, no balance credits, and no withdrawals are authorized by this document.

## Mainnet evidence acceptance contract (implementation still missing)

The existing `test-support/bsc-testnet-receipt.js` explicitly accepts testnet chain ID `0x61`; it must **not** be reused as proof of BSC mainnet deposits (chain ID 56 / `0x38`). Before crediting any mainnet USDT, implement and independently test all of the following, with an explicitly reviewed token allowlist:

- Query receipt and canonical block data from trusted RPC providers, not client-supplied fields; verify successful transaction status, chain ID, block hash, block number and sufficient independently configured finality. On disagreement, outage or reorganization, **do not credit**.
- Decode only an ERC-20 `Transfer(address,address,uint256)` event from the exact allowlisted token contract; require correct transaction hash, log index, unremoved log, recipient topic, positive amount and contract address. A transaction to a different contract or recipient must fail closed.
- Resolve the recipient address against a **uniquely active assignment to the intended user at the event's relevant block/time**. A current assignment alone is insufficient when addresses can be reassigned. Lock the assignment and enforce account ownership during posting.
- Verify token `decimals` against independently approved contract metadata. Convert base units to ledger units exactly, rejecting rounding, overflow, unsupported precision and mismatched amounts.
- Persist canonical `chainId:transactionHash:logIndex` evidence and post a matching, balanced journal in **one** PostgreSQL transaction, under unique constraints and concurrency-safe locking. Test replay, multiple logs per transaction, rollback, duplicate notifications and simultaneous workers.
- Reconcile independently observed finalized transfers with stored evidence, assigned users and ledger credits; alert on missing, orphaned, reversed or unmatched entries. Define an incident freeze procedure before any activation.

**Security boundary:** `rehearseVerifiedDepositPosting` is disposable-database-only and accepts caller-supplied evidence and journal accounts; it is **not** a production verifier, authorization layer or crediting endpoint. Its green tests do not discharge the above requirements.

## Historical wallet assignment gap — blocking finding

The currently reviewed catalog contract requires `user_wallet_assignments(id,user_id,wallet_id,assignment_type,status,ended_at)` and `wallets(wallet_address,chain_id,...)`. It does **not** require an immutable chain-block-based assignment history, a start block, an end block, or evidence that an address was never reassigned to another customer.

Consequently, `src/deposit-wallet-ownership-inspection.js` can only check a supplied **current** assignment snapshot, while `src/deposit-historical-assignment.js` checks caller-supplied intervals and boolean attestations. **Neither establishes historical ownership from trusted storage.** These modules must not be wired to production balance crediting.

Before any live credit:
1. Independently inspect the actual FadeHost PostgreSQL catalog and existing wallet-assignment history (read-only) to determine whether trustworthy immutable ownership intervals already exist.
2. If not, design and review an additive, auditable assignment-history schema with explicit start/end block boundaries, no overlapping assignment of one deposit address to different users, immutable historical rows, and a safe handling policy for previously used or reassigned addresses.
3. In a disposable PostgreSQL 17 environment, prove concurrent reassignment exclusion, unique address-to-user resolution at the transfer block, rollback, and fail-closed behavior on missing/ambiguous historical records.
4. Tie the verified event block, wallet ownership, intended user, and user ledger account to the **same atomic** posting transaction with suitable locks. Independent RPC evidence and account authorization remain mandatory.
5. Do not apply a migration to production or change assignment behavior without a separately reviewed backup, migration plan, rollback plan and owner approval.

**Decision: historical wallet ownership is NOT VERIFIED; live deposit crediting remains BLOCKED.**

## Destination account locking integration status

The disposable-only `rehearseVerifiedDepositPosting` now optionally accepts `destinationOwner` and locks the user's USDT AVAILABLE account in the evidence+journal transaction, checking that the credit entry targets it. **This is deliberately not a production authorization gate:** the argument is optional to preserve existing rehearsal fixtures, and no trusted historical wallet ownership or RPC verification is connected. Any future live implementation must require and independently derive destination ownership, recheck it under lock, and fail closed when absent. Do not interpret successful rehearsal CI as authorization to accept deposits.


## Historical ownership migration is NOT a verified ownership source

The review-only `deposit_address_ownership_history` table prevents overlapping
block intervals and row updates/deletes, but **does not independently authenticate**
its `wallet_id`, `wallet_address`, `user_id`, `start_block`,
`end_block`, or free-text `verified_source` inputs. In particular, the
foreign keys to `wallets(id)` and `users(id)` do not establish that the
wallet row has the recorded address, chain, or platform-controlled status.
The trigger does not prevent privileged TRUNCATE, DDL, or superuser changes.

**Fail-closed production requirements:** review the actual wallet catalog,
enforce wallet ID/address/chain correspondence at the database boundary,
independently authenticate the source and exact chain-block assignment
boundaries, define a controlled correction/close-interval process with audit
evidence, and verify the ingest role cannot mutate history. Do not backfill
unknown historical ownership from current wallet assignments. Until these
controls exist and are tested, this table cannot authorize a live credit.
