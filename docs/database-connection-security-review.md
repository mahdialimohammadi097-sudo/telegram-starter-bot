# PROFINO Database Connection Security Review

**Review date:** 2026-11-11  
**Scope:** Static review of the default `main` branch only. No FadeHost dashboard, live service, environment variables, or database was accessed.

## Executive finding

The current PostgreSQL pool explicitly sets `ssl: false` in `src/database.js`. This disables TLS for the PostgreSQL client connection. If the FadeHost PostgreSQL endpoint is reached over an untrusted network, database traffic may be exposed to interception or modification. The actual FadeHost network topology and whether traffic remains on a private provider network have not been verified.

**Severity:** Security hardening required; deployment-specific exploitability is unverified.

## Evidence reviewed

- `src/database.js`: creates a `pg.Pool` from `DATABASE_URL`, with `ssl: false`, pool size 5, and connection timeout 10 seconds.
- `index.js`: imports `inspectCoreSchema` and runs it during startup after a successful database connection.
- `src/health-report.js`: sends only aggregate schema status to the configured Super Admin: expected-table count, inventory count, index count, trigger count, and missing table names. It does not format or send column definitions, index definitions, trigger definitions, or function bodies.
- `src/health-http.js`: exposes `/healthz`, `/livez`, the optional POST `/telegram` webhook, and a plain-text root response. No database-schema diagnostic HTTP route is present in this file.
- `index.js`: the startup report recipient is a fixed `ADMIN_ID` constant. Confirm this ID is controlled by the intended project owner before relying on the private report path.

## Positive controls observed

- The schema diagnostic is invoked internally during startup; no public `/dbschema` route was found in the reviewed HTTP server.
- The startup report formatter emits aggregate counts and missing expected table names rather than raw database definitions or row data.
- The startup report explicitly states that checks are read-only and that no balances, transactions, users, or schema were changed.

## Required remediation before production approval

1. Confirm with FadeHost whether the PostgreSQL endpoint supports TLS and whether its certificate chain can be validated from the application runtime.
2. If TLS is supported, configure the PostgreSQL client to require TLS with certificate verification enabled. Prefer the provider CA bundle when required; do not disable certificate verification merely to make a connection succeed.
3. If the provider documents a private-network exception, record the endpoint topology, network boundary, and provider assurance before accepting a non-TLS connection.
4. Add automated tests for the chosen connection-security configuration, including fail-closed behavior when TLS is required but unavailable.
5. Verify the configured Super Admin Telegram ID through an authorized owner-controlled process. Do not expose schema definitions through public HTTP endpoints or customer-facing bot messages.

## Explicitly not done

- No change to `src/database.js` was made because FadeHost TLS support, CA requirements, and current runtime networking are unverified. A blind change could break the deployed service or encourage insecure certificate bypass.
- No connection to FadeHost or PostgreSQL was attempted.
- No credentials, environment variables, production data, or schema were accessed or changed.
- No migration, deployment, merge, deposit, withdrawal, or money movement occurred.

## Next evidence needed

A provider-documented answer for the FadeHost PostgreSQL hostname/network path, TLS availability, required CA configuration, and whether the application connects over a private provider network. Once verified, implement the narrowest configuration change on a separate branch and test it against a disposable PostgreSQL service before considering deployment.
