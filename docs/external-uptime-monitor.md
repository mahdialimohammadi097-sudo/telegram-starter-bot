# PROFINO External Uptime Monitor

This GitHub Actions workflow checks the FadeHost application's public liveness endpoint every five minutes.

## Endpoint

- `GET /healthz`
- Returns only `ok` with HTTP 200 while the application process is serving HTTP.
- It does not expose database status, Telegram credentials, user data, balances, or transactions.

## Telegram alerts

For an alert to the Super Admin when the external check fails, add this repository Actions secret:

- Name: `PROFINO_MONITOR_BOT_TOKEN`
- Value: the existing PROFINO bot token

Add it in GitHub → repository Settings → Secrets and variables → Actions → New repository secret. Never put the token in source code, issues, workflow files, or chat.

The monitor uses Telegram's sendMessage API only; it does not call getUpdates and does not interfere with the bot's polling process.

## Scope and limitations

- Runs every five minutes on GitHub Actions, plus manual dispatch.
- If the endpoint is unavailable, the job fails and sends a Telegram alert when the secret is configured.
- A reachable endpoint proves the process is serving HTTP, not that every bot feature is working. The in-process 60-second monitor separately checks Telegram API and PostgreSQL connectivity.
- This is an external monitor, independent of the FadeHost process. It cannot restart FadeHost; restart/redeploy automation requires hosting-provider control access and explicit permissions.
