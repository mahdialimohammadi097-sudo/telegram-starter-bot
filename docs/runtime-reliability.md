# PROFINO Runtime Reliability

## Runtime readiness contract

- `GET /livez` returns HTTP 200 while the Node.js process is serving HTTP.
- `GET /healthz` returns HTTP 200 only when PostgreSQL is reachable, the Telegram API is reachable, and the Telegram update receiver is active.
- `GET /healthz` returns HTTP 503 during startup, dependency outages, inactive polling/webhook reception, or graceful shutdown.
- The health response contains status flags only; it never returns secrets, user data, balances, or transactions.

## Startup

1. Bind the HTTP server to `0.0.0.0` before waiting for external dependencies so the hosting platform can reach the process. The default port is `8080`; always honor the hosting platform's injected `PORT` value.
2. Retry transient PostgreSQL connection and Telegram API failures with capped exponential backoff.
3. Fail fast on invalid Telegram credentials.
4. Initialize the existing post-history and admin audit schemas.
5. In polling mode, remove any previous webhook without dropping pending updates and start long polling.
6. In webhook mode, register the HTTPS webhook and verify its configured URL through the periodic monitor.
7. The scheduled-post recovery and health monitor run independently of Telegram update reception.

## Recovery and shutdown

- Polling failures trigger capped exponential retry delays; authentication/configuration errors are not retried indefinitely.
- The periodic monitor checks Telegram API/webhook status and PostgreSQL connectivity and updates readiness.
- SIGINT/SIGTERM mark the service unready, stop the scheduler and health monitor, stop Telegram polling, close the HTTP server, and close the PostgreSQL pool.

## Validation and remaining operational proof

- Unit tests cover runtime readiness state, HTTP liveness/readiness behavior, webhook route gating, and dependency status callbacks.
- GitHub Actions runs syntax checks and the complete Node.js unit test suite.
- A successful CI run does not prove FadeHost deployment, Telegram delivery, database credentials, webhook routing, or polling exclusivity.
- Production acceptance requires a supervised deployment, `/healthz` returning HTTP 200, a real test message round-trip in the private bot chat, a restart test, and a shutdown/restart check. Do not use customer funds or enable financial execution for these tests.

### Scheduled preview shutdown

Shutdown stops new scheduler ticks and waits for startup recovery and the claimed preview batch before closing PostgreSQL. A completed preview can therefore record its Telegram message and chat IDs. The PG17 drill blocks a synthetic delivery during shutdown and verifies its history after restarting. A separate fixture represents a hard interruption: startup marks the pending result unknown and does not resend it. Actual host termination grace time and Telegram delivery still require staging verification.
