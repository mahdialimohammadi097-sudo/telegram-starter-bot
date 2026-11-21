# PROFINO — independent PostgreSQL 17 backup and isolated restore

**Status:** Procedure prepared, NOT executed. Do not use production Restore, enable public database access, or activate live financial operations.

## Observed limitations
- Existing FadeHost `profino-db`: PostgreSQL 17, private-only, four provider snapshots; latest displayed ID `91d63c6c`. Snapshot existence does not prove restore integrity.
- Existing `telegram-bot` has a scheduled-command runner but Terminal is paywalled.
- A scheduled `command -v pg_dump ...` probe returned `PG_DUMP_NOT_AVAILABLE`. Remove this temporary 15-minute schedule after collecting its result. Preserve the daily `node scripts/cleanup.js` schedule.
- GitHub-hosted Actions cannot directly reach a private-only FadeHost DB; do not publish the DB to work around this.

## Preferred independent backup route
Use a **temporary, non-bot utility execution environment** attached to the *same private network*, if FadeHost supports it. It is not a second Telegram bot. This environment needs PostgreSQL **17** client tools (`pg_dump`, `pg_restore`, `psql`), enough free space, and an approved way to securely export the resulting encrypted file. Never use application logs, GitHub artifacts, or Telegram messages to transfer raw database backups.

A backup is not independently retained until the encrypted file has been copied to a separate storage location and a checksum has been verified there. If the platform has no secure export mechanism, stop; a file stranded on the app's ephemeral filesystem is not an independent backup.

## Backup (authorized private-network shell, after tools and secure export confirmed)
Set `DATABASE_URL` through the environment's secret mechanism, not as a command-line literal or in a log. Restrict file permissions. Use a temporary directory with enough space, then:
```sh
set -eu
umask 077
pg_dump --version                         # must be PostgreSQL 17 client
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl --file=profino.dump
pg_restore --list profino.dump >/dev/null
sha256sum profino.dump
```
`pg_dump` obtains a transactionally consistent logical snapshot, but the command's successful exit and archive listing do **not** prove successful restoration. This example produces an unencrypted local dump: **encrypt it before export**, with a vetted encryption utility and key managed outside FadeHost; then securely transfer only the encrypted artifact and verify its checksum. Never print dump content, secrets, or keys.

## Independent recovery drill (disposable database only)
Create a **new, isolated PostgreSQL 17 database** with no production traffic and a distinct connection string. Confirm its identity before restore. Decrypt the saved archive locally within the isolated environment. Run:
```sh
pg_restore --dbname="$RESTORE_DATABASE_URL" --no-owner --no-acl --exit-on-error --single-transaction profino.dump
```
Check expected schema, row counts, foreign keys, constraints, and ledger reconciliation against a captured source inventory. Keep test credentials separate. Never aim `pg_restore` at the production connection URL. Destroy temporary data securely after recording sanitized results.

## Blocking decisions
1. Can FadeHost run a temporary private-network utility environment with PostgreSQL 17 client tools?
2. Can that environment securely export an encrypted backup outside FadeHost without using logs or GitHub?
3. Can an isolated PostgreSQL 17 restore target be provisioned?
4. Does a real end-to-end restore and reconciliation pass?

Until all four are confirmed, mark independent backup/restore **UNVERIFIED**. The presence of provider snapshots is still valuable, but not a substitute for this drill. The migration and live USDT flows remain gated by separate approval and security/accounting checks.
