# PROFINO deposit schema readiness — operator procedure

**Read-only audit only. Not permission to enable real deposits.**

Run this only from an authorized environment that can reach FadeHost private PostgreSQL, using a database account with SELECT/catalog permissions and no write privileges.

```bash
DATABASE_URL='<private read-only connection string>' node scripts/audit-deposit-schema.js
```

The command enforces a read-only transaction, sets a statement timeout, emits JSON containing `ready`, `missing`, and `incompatible`, and exits nonzero for missing prerequisites. **Never paste credentials or raw connection strings into chat, tickets, logs or CI output.** Do not place the private connection string in GitHub repository files.

A passing schema audit is necessary but not sufficient. Review actual constraints, triggers, access controls, ownership history, network configuration, backup/recovery and ledger reconciliation separately. The `verified_deposit_evidence` table is currently only a disposable CI fixture; its absence in production is an expected blocker until a reviewed migration exists. Do not run the fixture against production.

Keep real deposits, withdrawals, settlement and user balances disabled until independent security/accounting checks and explicit final owner authorization.

## FadeHost operator checklist

1. Open the **existing** PROFINO bot service in FadeHost; do not create a new bot or expose PostgreSQL publicly.
2. Run a one-off command from a private-network-capable service shell or one-off job using the reviewed branch and a **read-only** PostgreSQL role. Do not modify the production startup command or bot token.
3. Set `DATABASE_URL` privately in the execution environment (never paste it into chat or a repository). Run `npm run audit:deposit-schema`.
4. A successful inspection returns a single JSON line containing `audit`, `ready`, `missing`, and `incompatible`. Exit status 2 means missing/incompatible prerequisites; exit status 3 means inspection failed. The script must not run migrations.
5. Share **only** the sanitized JSON result, not environment variables, console history, secrets, connection URLs, or database contents.

If FadeHost does not provide a shell or one-off job, **stop** and request a supported private-network execution method. GitHub-hosted runners cannot reach the private-only PostgreSQL endpoint. Do not enable public database access as a workaround.
