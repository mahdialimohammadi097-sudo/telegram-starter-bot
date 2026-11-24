# Production baseline reconciliation — 2026-11-24

Review only; no deployment or financial activation.

Production baseline: e0d7509b43605493beb6a20485d5d17ce0ef8e16
Tested integration baseline before this reconciliation: 8f62e9c1ff60dee81621e54d92643a224346feac
Common ancestor: aeefcc9f2b94e54f164b9e3af89ff7e10a10b89f

The 18 paths changed on main were compared against integration. Four are byte-identical: database-diagnostics and admin-message-edit, both with their tests. Retain the reviewed integration versions of external-uptime (same endpoint retries plus serialized monitoring and validated Telegram response), validate (clean install plus expanded PostgreSQL matrix and dependency/credential checks), index (existing startup report, guarded audit, shutdown drains), admin-ops (idempotent safe message edits and stricter status checks), database (idle client error handler with sanitized diagnostic and explicit TLS policy), FadeHost audit script/test/workflow/runbook (existing command plus shared catalog checks and sanitized failures), and admin-schema-audit/test (historical metadata plus shared catalog contract and rollback safety). The commands path preserves richer existing handlers and restores legacy private-owner Persian navigation without reintroducing obsolete placeholder financial screens. The two main-only owner-menu helper/test paths are restored with strict numeric identity and matching private chat, no customer preference lookups, and no free-form draft translation. Customer messages remain English; private admin language selection is unchanged.

This reconciliation intentionally does not merge the alternative #121/#122 or #111–114/#119–120 stacks. Those require separate evidence review. Historical record consistency is not independently verified ownership. All production migration, real deposits, withdrawals, settlement and other financial execution remain unauthorized. Exact combined CI, current private database and least-privilege evidence, actual production backup restore, branch protection, and supervised release/rollback evidence remain gates. Do not merge into main merely because the ancestry is reconciled; main auto-deploys.
