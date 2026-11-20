# PROFINO Financial Product Implementation Plan

**Status:** Design and safe-foundation phase  
**Scope:** Product workstreams 1–5: security/schema audit, wallet and payment lifecycle, investment accounting, admin financial operations, and verification/release.  
**Currency:** USDT  
**Customer-facing language:** English  
**Private admin language:** English and Persian  
**Explicit exclusion:** Exchange-connected arbitrage, automated trading, order execution, and trading-strategy engines are out of scope and must not be added.

## Safety boundary

This document is an implementation specification, not evidence that any money-handling workflow is live. The existing bot's deposit and withdrawal screens remain disabled. No customer funds, production balances, financial rows, or production schema are changed by this plan.

Do not enable real deposits, withdrawals, investment acceptance, profit crediting, reserve transfers, or customer payouts until all release gates in this document are satisfied, independently reviewed, and explicitly approved by the owner. Do not promise or advertise guaranteed returns. Any displayed yield must be backed by a documented, verifiable funding source, liquidity plan, risk disclosure, and legal review.

## Workstream 1 — Security, schema and ledger audit

### Required work
1. Retrieve the complete read-only schema for all production financial tables: deposits, withdrawals, investments, plan versions, profits, referrals, ledger accounts, ledger transactions, ledger entries, reserve wallets/snapshots/exceptions, wallet assignments, wallet transfers and transfer approvals.
2. Read every user-defined trigger and function body, especially deferred ledger balancing triggers.
3. Verify the owner has an active `admin_users` membership and that audit writes satisfy the actual foreign keys and CHECK constraints.
4. Trace every code path that reads or writes ledger data. Confirm all posting paths use one transaction, lock affected accounts, enforce idempotency and write balanced entries.
5. Keep admin access private-chat-only; audit every privileged mutation; use least privilege for future staff roles.
6. Replace process-local rate limits and volatile admin sessions before adding multiple bot replicas. Keep the scheduler single-instance until lease/heartbeat-aware recovery exists.

### Acceptance criteria
- Every financial table has a recorded schema/constraint/index inventory.
- Every financial trigger is understood and tested against a disposable PostgreSQL database.
- No posting path can create an unbalanced, duplicate, negative, or partially committed transaction.
- Admin membership and audit writes are verified using read-only checks.
- No production data is changed during the audit.

## Workstream 2 — Wallet, deposits and withdrawals

### Wallet
- Keep the customer wallet read-only until all ledger accounts and account types are mapped.
- Display only posted ledger entries; clearly distinguish available, invested, and recorded-profit balances.
- Never infer a zero balance when required ledger accounts are missing; show a safe unavailable state and log the issue.
- Use exact decimal strings / integer base units. Never use JavaScript floating-point arithmetic for money.

### Deposit lifecycle (proposed; do not implement against production until schema mapping)
1. User selects Deposit and receives clear network/token instructions only after an approved deposit route exists.
2. A generated deposit intent is bound to one user, one asset, one network and one expiry window.
3. A watcher observes the exact token contract and network; it does not trust screenshots or user-submitted transaction hashes as proof.
4. Confirmation policy accounts for chain finality, reorgs, duplicate events and underpayment/overpayment.
5. A deposit remains pending until independently verified. Only then may a single idempotent ledger transaction credit the user's available account.
6. Reconciliation compares observed on-chain transfers with credited ledger entries and raises exceptions for mismatches.

### Withdrawal lifecycle (proposed; disabled)
1. User submits an amount and verified destination; exact precision, minimum/maximum, fees and available balance are checked.
2. Require step-up confirmation and a fresh authorization; apply account status, velocity, risk and applicable compliance checks.
3. Reserve funds atomically so concurrent requests cannot spend the same balance.
4. Require configured approval controls, with a second approver for thresholds where appropriate.
5. Broadcast only after approval; record transaction hash and network status.
6. Reconcile final chain outcome. Failed/expired withdrawals release the reservation through a compensating, audited transaction; never edit posted ledger history.

### Acceptance criteria
- Duplicate chain events and duplicate user submissions are idempotent.
- Concurrent withdrawal attempts cannot overdraw.
- Unknown/unsupported token contracts and networks are rejected.
- A chain transaction is never treated as confirmed solely because a hash was submitted.
- Reversals are compensating entries, not destructive edits.
- Testnet-only integration tests pass before any real network feature is considered.

## Workstream 3 — Investment plans, investments and profit accounting

### Plan catalogue
- Publish only approved, versioned plans with asset, minimum/maximum contribution, term, lock-up, fees, risk disclosures, eligibility and effective dates.
- A plan version used by an investment is immutable; later edits create a new version.
- Do not display a plan as available until funding, liquidity, legal and operational approvals are documented.

### Investment lifecycle
- Present a clear terms summary and require explicit acceptance.
- Validate exact amount and available balance, then atomically move funds from available to invested using balanced ledger entries.
- Record the exact plan version, amount, start/end dates, status and consent evidence.
- Support cancellation/maturity only through defined state transitions and audited ledger postings.

### Profit accounting
- Separate calculation from approval and posting.
- Every accrual is uniquely identified by investment and accrual date; retries must not create duplicates.
- Validate that the investment is eligible, active for the accrual period, not over its cap, and supported by an approved funding source.
- Profit records remain pending until authorized approval; approval must create one balanced, idempotent ledger transaction.
- Rejected, corrected or reversed profit records retain their audit trail.
- No guaranteed return language. Rates, if any, are not promises and must be evidence-based and legally reviewed.

### Acceptance criteria
- Investment and profit state transitions are explicit and auditable.
- Plan terms cannot silently change for existing investments.
- Daily accrual is deterministic, idempotent and reproducible.
- No profit is credited without an approved record and matching ledger transaction.
- Maturity, cancellation, early exit and loss scenarios are tested.

## Workstream 4 — Admin panel and financial operations

### Required capabilities
- Financial overview: pending deposits, pending withdrawals, investments, profit approvals, reconciliation exceptions and reserve snapshots.
- User financial profile: read-only balances, investment history, deposits, withdrawals, profit history and audit timeline.
- Approval queues with amount, asset/network, age, risk flags, evidence and current state.
- Maker/checker separation for sensitive approvals; the person who creates a request should not be its sole approver.
- Explicit confirmation screens showing the exact user, amount, currency, destination and action.
- Immutable admin audit events with actor, timestamp, target, before/after state, reason and correlation/reference ID.
- Exportable reports with access control and redaction of secrets/private data.
- Persian/English language selection for the private admin panel. Customer-facing messages remain English.

### Acceptance criteria
- Every privileged action is permission-checked server-side, not only hidden in the UI.
- Sensitive actions require a fresh confirmation tied to the exact request version.
- Stale approvals are rejected.
- Every successful or failed mutation has an audit outcome.
- Financial dashboards reconcile to the ledger and clearly label pending versus posted values.

## Workstream 5 — Testing, operations and release

### Test layers
1. Unit tests: amount parsing, rounding boundaries, balance invariants, idempotency keys, state transitions and permission rules.
2. Disposable PostgreSQL integration tests: migrations, constraints, deferred triggers, concurrent posting, rollback and lock behavior.
3. Testnet integration tests: deposit detection, confirmations, reorg handling, withdrawals, fees and reconciliation.
4. End-to-end bot tests: English customer journeys and bilingual private admin workflows.
5. Security tests: authorization bypass, replay, duplicate callbacks, rate-limit abuse, session loss, secret exposure and audit tampering.
6. Operational tests: backup/restore, database outage, Telegram outage, restart during an in-flight operation, scheduler lease recovery and incident response.

### Release gates
- All automated tests and CI checks pass.
- Production schema/trigger audit is signed off.
- Independent code/security review is complete.
- Monitoring, alerting, backups and reconciliation are operational.
- Legal/compliance review is complete for the jurisdictions and business model involved.
- Testnet and controlled pilot results are reviewed.
- Owner gives separate explicit authorization for any production deployment and for any activation of money movement.

## Current implementation boundary

Already evidenced in source/runtime: Telegram bot runtime, PostgreSQL connectivity, private-chat guard, basic owner-only admin operations, read-only wallet balance query, exact eight-decimal helper hardening in the phase-one branch, and explicit disabled deposit/withdrawal messages.

Not yet evidenced as complete: end-to-end deposit detection, withdrawal processing, atomic production posting service, investment acceptance, profit accrual/approval/posting, referral rewards, full financial admin console, disposable-PostgreSQL integration tests, testnet payment flows, and production release sign-off.

## Explicitly out of scope

- Exchange API integrations for arbitrage.
- Automated buying/selling or order execution.
- Arbitrage strategy simulation or live trading.
- Trading with customer funds.

These exclusions are deliberate product decisions, not pending tasks.
