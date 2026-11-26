# PROFINO — existing Telegram service

Review candidate for the existing @PROFINO1bot and @PROFINO1 channel. Node.js / grammY, PostgreSQL 17, USDT. The existing FadeHost service is `telegram-bot`; pushes to `main` trigger automatic deployment.

**Review only. NO-GO for real funds.** Do not create a second bot, deploy this candidate, apply production migrations, or activate financial operations on the strength of CI results.

## Free, isolated validation

- Use the existing GitHub Actions checks on the exact candidate revision, or run `npm ci` and `npm test` in an offline development environment with no production credentials.
- PostgreSQL integration tests require a genuinely disposable PostgreSQL 17 service and explicit opt-in (`PROFINO_DISPOSABLE_POSTGRES=yes`). Use only the documented loopback fixture databases `profino_test` and `catalog_rehearsal`; never a tunnel to production. A skipped PostgreSQL suite is not release evidence.
- The Node.js 22/24/26 CI matrix, focused PostgreSQL replay and synthetic backup/restore are the reproducible test paths. No live funds, real Telegram credentials or production database are needed.
- See [single-bot validation policy](docs/single-bot-validation-policy.md) and [release evidence and gates](docs/priority7-8-release-evidence-2026-11-25.md). The separate staging runbook is historical, not authorization to create another bot.

## Existing service configuration

Use protected host settings; never commit or print a bot token, database connection string, or private key. See `.env.example`. Polling is the existing default. Webhook mode requires an HTTPS base URL and a random secret containing only letters, digits, underscores or hyphens (1–256 characters). Do not start a competing receiver with the production token.

Preserve the current database/TLS configuration until the real provider and network settings have been independently verified. Restricted verify-only runtime is a reviewed opt-in, not a migration procedure. The default legacy startup contract must not be confused with least-privilege release approval.

## Operator-only readiness

Use the reviewed read-only audit tools through an authorized private connection. An audit's success describes its own scope, not production financial readiness. Do not make the database public or bypass provider restrictions. See [independent backup and restore](docs/independent-postgres-backup-restore.md), [migration approval gate](docs/production-evidence-migration-approval.md), and the release evidence document.

An exact deployed revision, actual catalog and role evidence, isolated recovery from a real encrypted backup, independent custody/liquidity/liability and compliance checks, supervised single-bot acceptance and separate final owner authorization remain required. Never restore over production.

MIT license. Originally based on the FadeHost Telegram starter template.
