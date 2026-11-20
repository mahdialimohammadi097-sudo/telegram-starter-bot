# PROFINO — Project-wide execution priorities

These instructions apply to engineering agents and contributors working on this repository until PROFINO's initial production launch is completed.

## Owner's overriding delivery priority
**Finish the existing single Telegram bot as quickly as safely possible and prepare it to accept real USDT deposits from users.** Work that does not directly unblock this launch must be deferred. Do not spend cycles creating optional features, cosmetic improvements, or redundant tests while critical launch blockers remain.

## Order of execution
1. Audit and integrate existing branches and PRs into a stable release candidate; avoid duplicating work.
2. Complete the essential customer flows: registration, wallet, deposit verification and crediting, investment lifecycle, withdrawal controls and reconciliation.
3. Resolve launch-blocking financial integrity, security, compliance and operational defects. Run focused tests necessary to establish release safety.
4. Validate deployment configuration, database backup/restore, end-to-end Telegram flows and operational readiness; obtain explicit owner sign-off.
5. Enable real USDT handling **only after** the above gates are satisfied and the owner explicitly authorizes production activation.
6. Postpone optional improvements, additional UX polish, peripheral tests and nonessential PRs until after launch.

## Non-negotiable boundaries
- One existing Telegram bot: @PROFINO1bot; do not create a second bot.
- Customer-facing messages in English only; private admin interface supports Persian and English; owner communications in Persian.
- USDT only. Approved investment denominations: 10, 25, 50, 75, 100 USDT. At most five concurrent active investments per user.
- No exchange trading, arbitrage engine or order execution inside the bot.
- Preserve exact-decimal accounting, atomic double-entry postings, idempotency, access controls, immutable audit history and reconciliation.
- No real deposits, withdrawals, custody, settlements or profit distribution without completed security and financial verification and the owner's explicit approval. Do not claim production readiness without evidence.
- Avoid unverified claims about guaranteed profits or investment performance.

## Reporting
For each substantial engineering step, state what changed, evidence/tests, remaining **launch blockers**, PR/commit status and the single highest-priority next action. Do not invent progress percentages.

This file expresses the owner's standing priority and should be consulted before selecting work in every future chat, agent or Work session that accesses this repository.
