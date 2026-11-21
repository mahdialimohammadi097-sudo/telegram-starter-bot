# PROFINO deposit schema readiness — operator procedure

**Read-only audit only. Not permission to enable real deposits.**

Run this only from an authorized environment that can reach FadeHost private PostgreSQL, using a database account with SELECT/catalog permissions and no write privileges.

```bash
DATABASE_URL='<private read-only connection string>' node scripts/audit-deposit-schema.js
```

The command enforces a read-only transaction, sets a statement timeout, emits JSON containing `ready`, `missing`, and `incompatible`, and exits nonzero for missing prerequisites. **Never paste credentials or raw connection strings into chat, tickets, logs or CI output.** Do not place the private connection string in GitHub repository files.

A passing schema audit is necessary but not sufficient. Review actual constraints, triggers, access controls, ownership history, network configuration, backup/recovery and ledger reconciliation separately. The `verified_deposit_evidence` table is currently only a disposable CI fixture; its absence in production is an expected blocker until a reviewed migration exists. Do not run the fixture against production.

Keep real deposits, withdrawals, settlement and user balances disabled until independent security/accounting checks and explicit final owner authorization.
