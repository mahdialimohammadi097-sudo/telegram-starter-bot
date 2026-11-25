# PROFINO deposit schema readiness — operator procedure

**Read-only audit only. Not permission to enable real deposits.**

Use the reviewed integration revision in an authorized private-network-capable environment. Provision a deliberately separate SELECT/catalog-only PostgreSQL role. Supply DATABASE_URL privately through the environment; never type a credential-bearing URL into shell history, logs, CI output or repository files. Review the database TLS policy before execution. Do not substitute the production bot's write-capable credentials.

## Commands and result contracts

With the reviewed dependencies already installed and the private environment configured:

```sh
npm run audit:deposit-schema
npm run audit:deposit-schema -- --include-legacy-assignments
```

The first command checks the deposit catalog. The second checks the catalog and legacy active deposit wallet assignments in one bounded repeatable-read, read-only transaction. For the combined result require both catalog.ready and assignments.ready, conflictingActiveDepositWallets equal to the string "0", activeDepositWalletUniquenessEnforced true, and realDepositsEnabled false. It does not prove distinct physical addresses, historical provenance, on-chain proof or posting readiness. Row-security filtering must fail closed rather than hide assignment conflicts.

Exit status 0 means the selected limited checks passed; 2 means prerequisites are missing or incompatible; 3 means execution failed. The combined JSON uses nested catalog and assignments objects. Share only sanitized diagnostic JSON, not raw errors or user records.

## Migration boundaries

A reviewed evidence-table candidate exists at migrations/20261121_verified_deposit_evidence.sql. This is not evidence that the migration was applied to production. Historical ownership candidate PR #197 is separate, draft and review-only. Do not apply either candidate automatically. Independent provenance, actual schema and privileges, operational backup and isolated restoration, and separate migration authorization remain mandatory. Never infer historical ownership from current assignments.

## Current operational evidence (2026-11-25)

PR #56, GitHub Actions job 139062589258: authenticated FadeHost MCP connection, existing bot running, HTTP root and health endpoints 200, database connected, Telegram API connected, receiver active and ready=true. This is point-in-time health, not a catalog audit or restore proof. Direct database and private-network tools were not advertised. The existing command-execution tool declares a paid-plan restriction; no command was issued. The schedule inventory returned zero entries. Do not buy or upgrade a service or use an alternate route to evade plan restrictions.

## Remaining operator gates

Use a supported free private-network execution method only if its availability, authorization and isolation are confirmed. If none is available, record the production audit as blocked. Never expose the database publicly, change startup commands, or deploy unreviewed code to obtain audit access. GitHub-hosted disposable PostgreSQL tests do not validate the live database.

Keep real deposits, withdrawals, settlement and production financial posting disabled until independent security/accounting checks, live catalog and backup/restore verification, operational readiness and explicit separate final owner authorization are all satisfied.
