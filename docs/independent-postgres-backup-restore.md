# PROFINO — independent PostgreSQL 17 backup and isolated restore

**Status:** Procedure prepared, NOT executed. Do not use production Restore, enable public database access, or activate live financial operations.

## Observed limitations
- Historical panel observation (2026-11-21): existing FadeHost `profino-db` was PostgreSQL 17 and private-only, with four provider snapshots. This is not a current inventory, retention guarantee or export. Snapshot existence does not prove restore integrity.
- Existing `telegram-bot` has a scheduled-command runner but Terminal is paywalled.
- A scheduled `command -v pg_dump ...` probe returned `PG_DUMP_NOT_AVAILABLE`. This is historical evidence, not an instruction to recreate the probe or change any current schedule. Verify actual schedule state before separately authorized cleanup.
- GitHub-hosted Actions cannot directly reach a private-only FadeHost DB; do not publish the DB to work around this.

## Preferred independent backup route
Use a **temporary, non-bot utility execution environment** attached to the *same private network*, if FadeHost supports it. It is not a second Telegram bot. This environment needs PostgreSQL **17** client tools (`pg_dump`, `pg_restore`, `psql`), enough free space, and an approved way to securely export the resulting encrypted file. Never use application logs, GitHub artifacts, or Telegram messages to transfer raw database backups.

A backup is not independently retained until the encrypted file has been copied to a separate storage location and a checksum has been verified there. If the platform has no secure export mechanism, stop; a file stranded on the app's ephemeral filesystem is not an independent backup.

## Backup (authorized private-network shell, after tools and secure export confirmed)
Use an authorized private-network shell only. Have the operator provision a protected libpq service file and a separate password file (permissions 0600), or equivalent provider-managed libpq settings. Configure a service named `profino_backup_source` for the verified source and a distinct service `profino_restore_isolated` for the disposable target. Keep credentials outside repository, command-line arguments, shell history and logs. Do not expand a credential-bearing connection URI into `pg_dump` or `pg_restore` arguments. Disable shell tracing. Verify the service target and TLS policy privately before running. Restrict file permissions and use a temporary directory with enough space, then:
```sh
set -eu
umask 077
pg_dump --version                         # must be PostgreSQL 17 client
PGSERVICE=profino_backup_source pg_dump --format=custom --no-owner --no-acl --file=profino.dump
pg_restore --list profino.dump >/dev/null
sha256sum profino.dump
```
`pg_dump` obtains a transactionally consistent logical snapshot, but the command's successful exit and archive listing do **not** prove successful restoration. This example produces an unencrypted local dump: **encrypt it before export**, with a vetted encryption utility and key managed outside FadeHost; then securely transfer only the encrypted artifact and verify its checksum. Never print dump content, secrets, or keys.

## Independent recovery drill (disposable database only)
Create a **new, isolated PostgreSQL 17 database** with no production traffic and a distinct libpq service configuration. Verify its identity and isolation independently before restore (not merely the name of the service alias); use a role with no access to production. Decrypt the saved archive locally within the isolated environment. Run:
```sh
PGSERVICE=profino_restore_isolated pg_restore --no-owner --no-acl --exit-on-error --single-transaction --dbname=service=profino_restore_isolated profino.dump
```
Check expected schema, row counts, foreign keys, constraints, and ledger reconciliation against source evidence from the same backup cutoff. A later query against a changing source is not equivalent to the dump snapshot. Capture the source inventory in the same exported PostgreSQL snapshot used by pg_dump, with its exporting read-only transaction kept open until consumers import it, or during a separately authorized verified quiescent interval. If neither is possible, explicitly mark source-to-archive data comparison unverified. Do not claim exact equality from counts alone; privately compare reviewed application-level balances, journal references and other necessary records, never publish row contents or personal identifiers. Keep test credentials separate. Never aim `pg_restore` at the production database. Because this portability drill intentionally omits ownership and ACLs, success does not verify restoration of least-privilege roles, ownership or grants. Reconstruct and verify reviewed role/ACL configuration separately in the isolated target before calling recovery operationally ready. Provider snapshot recovery and a real independent restore remain unverified. Destroy temporary data securely after recording sanitized results.

## Blocking decisions
1. Can FadeHost run a temporary private-network utility environment with PostgreSQL 17 client tools?
2. Can that environment securely export an encrypted backup outside FadeHost without using logs or GitHub?
3. Can an isolated PostgreSQL 17 restore target be provisioned?
4. Does a real end-to-end restore and reconciliation pass?

Until all four are confirmed, mark independent backup/restore **UNVERIFIED**. The presence of provider snapshots is still valuable, but not a substitute for this drill. The migration and live USDT flows remain gated by separate approval and security/accounting checks.

## Hosting continuity checkpoint — 2026-11-26
Provider communications about post-trial free service availability conflict. Current private access, exact retention, secure export capability and independent restoration remain unverified. Treat the earlier retention deadline as a risk to resolve, not a guaranteed recovery window. A support clarification draft exists outside this public repository; it has not been sent. No payment, provider setting change, public database exposure or in-place restore is authorized. Do not wait for a financial release to preserve an authorized backup. If export is unavailable, retain existing snapshots without deleting or overwriting them and obtain an authorized provider-assisted export route. Never restore over the only copy of data.

Record only a sanitized recovery evidence manifest outside any public repository: source identity verified, snapshot cutoff and time zone, archive format and client/server major versions, encryption and independent custody verified, encrypted artifact checksum verified at the separate destination, isolated target identity and role boundary verified, restore exit result, source comparison scope and result, and outstanding discrepancies. Do not record secrets, paths containing credentials, raw database rows, or actual financial balances in public CI/PR logs. A checksum alone proves neither completeness nor authenticity; verify trusted origin and authenticated encryption before any isolated restore. Use an isolated target without production credentials, network access to production, or access to customer-facing services. Review archive provenance and executable database objects before restoring. Keep ownership/ACL reconstruction as a distinct verified step.

Exact candidate aad5d3f: all six CI workflows passed, 644 full and 155 focused tests, including the separate disposable PostgreSQL owner rehearsal (Node 22 job 139918094653). This establishes synthetic recovery and test behavior only. No new operational access or backup execution occurred. The remaining live gates are unchanged; no financial activation, production DDL, deployment or expense.
