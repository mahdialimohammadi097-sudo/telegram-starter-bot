import { safeDiagnosticCode } from "./diagnostic-safety.js";

const ADMIN_ID = 8810232463;

export function getHealthChanges(previous, current) {
  const changes = [];
  for (const service of ["telegram", "database"]) {
    if (previous[service] !== current[service]) {
      changes.push({ service, status: current[service] ? "RECOVERED" : "UNAVAILABLE" });
    }
  }
  return changes;
}

export function formatHealthAlert(changes, checkedAt = new Date()) {
  const lines = [
    "PROFINO — AUTOMATED HEALTH ALERT",
    "Time: " + checkedAt.toISOString()
  ];
  for (const change of changes) {
    lines.push(change.service.toUpperCase() + ": " + change.status);
  }
  lines.push("", "This alert contains service status only; no user, wallet, balance, or transaction data.");
  return lines.join("\n");
}

export function startHealthMonitor({
  bot,
  pool,
  intervalMs = 60_000,
  logger = console,
  now = () => new Date(),
  onStatus = () => {},
  telegramCheck = async () => { await bot.api.getMe(); return true; }
}) {
  let previous = { telegram: true, database: true };
  const pendingAlerts = new Map();
  let activeCheck = null;
  let stopped = false;

  async function performCheck() {
    try {
      const [telegramResult, databaseResult] = await Promise.allSettled([
        Promise.resolve().then(() => telegramCheck()),
        Promise.resolve().then(() => pool.query("SELECT 1 AS health_check"))
      ]);
      if (stopped) return;
      const current = {
        telegram: telegramResult.status === "fulfilled" && telegramResult.value !== false,
        database: databaseResult.status === "fulfilled"
      };
      onStatus(current);
      if (stopped) return;
      const changes = getHealthChanges(previous, current);

      for (const change of changes) {
        pendingAlerts.set(change.service, change);
        logger.warn("[health] " + change.service + " " + change.status.toLowerCase());
      }

      previous = current;

      if (pendingAlerts.size && current.telegram) {
        try {
          await bot.api.sendMessage(ADMIN_ID, formatHealthAlert([...pendingAlerts.values()], now()));
          pendingAlerts.clear();
        } catch (error) {
          logger.error("[health] alert delivery failed:", Number.isInteger(error?.error_code) ? error.error_code : "telegram_send_failed");
        }
      }
    } catch (error) {
      logger.error("[health] monitor check failed:", safeDiagnosticCode(error));
    }
  }

  function check() {
    if (stopped) return Promise.resolve();
    if (!activeCheck) {
      activeCheck = performCheck().finally(() => { activeCheck = null; });
    }
    return activeCheck;
  }

  // Run once immediately, then at a fixed interval. This never receives Telegram updates.
  const ready = check();
  const timer = setInterval(() => void check(), intervalMs);
  timer.unref?.();

  return {
    ready,
    stop() {
      stopped = true;
      clearInterval(timer);
      // Wait for any probe or Telegram delivery already in flight.
      return activeCheck ?? Promise.resolve();
    },
    check
  };
}
