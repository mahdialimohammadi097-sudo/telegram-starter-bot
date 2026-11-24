// PROFINO Telegram Bot runtime
// Polling is the default; webhook mode is optional.

import { Bot, webhookCallback } from "grammy";
import { registerCommands } from "./src/commands.js";
import { pool, testDatabaseConnection, closeDatabase } from "./src/database.js";
import { startScheduler } from "./src/scheduler.js";
import { ensurePostHistorySchema } from "./src/post-history.js";
import { ensureAdminOpsSchema } from "./src/admin-ops.js";
import { inspectCoreSchema } from "./src/database-diagnostics.js";
import { deliverAdminSchemaAudit } from "./src/admin-schema-audit.js";
import { formatStartupHealthReport } from "./src/health-report.js";
import { startHealthMonitor } from "./src/health-monitor.js";
import { createRuntimeHealthState } from "./src/runtime-health.js";
import { startHealthHttpServer } from "./src/health-http.js";

const ADMIN_ID = 8810232463;
const token = process.env.TELEGRAM_BOT_TOKEN;
const mode = (process.env.TELEGRAM_MODE || "polling").trim().toLowerCase();
const port = Number(process.env.PORT || 8080);

if (!token) {
  console.error("[startup] TELEGRAM_BOT_TOKEN is missing.");
  process.exit(1);
}

if (!["polling", "webhook"].includes(mode)) {
  console.error("[startup] TELEGRAM_MODE must be polling or webhook.");
  process.exit(1);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("[startup] PORT must be an integer between 1 and 65535.");
  process.exit(1);
}

const webhookSecret = (process.env.WEBHOOK_SECRET || "").trim();
if (mode === "webhook" && !/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
  console.error("[startup] WEBHOOK_SECRET is required in webhook mode and must use Telegram-compatible characters.");
  process.exit(1);
}

function validateWebhookUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid WEBHOOK_URL");
  }
  if (url.protocol !== "https:" || url.username || url.password ||
      url.search || url.hash || raw.includes("?") || raw.includes("#")) {
    throw new Error("Invalid WEBHOOK_URL");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") + "/telegram";
  return url.href;
}

let webhookUrl = null;
if (mode === "webhook") {
  try {
    webhookUrl = validateWebhookUrl((process.env.WEBHOOK_URL || "").trim());
  } catch {
    console.error("[startup] WEBHOOK_URL must be an HTTPS base URL without credentials, query or fragment.");
    process.exit(1);
  }
}

function safeErrorCode(error) {
  const code = error?.error_code ?? error?.response?.error_code ?? error?.code;
  return typeof code === "number" && Number.isInteger(code) ? code : "operation_failed";
}

const bot = new Bot(token);
const runtimeHealth = createRuntimeHealthState();
let healthServer = null;
let webhookHandler = null;
let botUsername = "PROFINO";
let healthMonitor = null;
let scheduler = null;
let shuttingDown = false;
let shutdownPromise = null;


function explainTelegramError(error) {
  const code = error?.error_code ?? error?.response?.error_code;
  if (code === 401) {
    console.error("[bot] Telegram rejected the token (401 Unauthorized).");
  } else if (code === 404) {
    console.error("[bot] Telegram answered 404. Check the bot token.");
  } else if (code === 409) {
    console.error("[bot] Telegram polling conflict: another process may be using this token.");
  } else {
    console.error("[bot] Telegram API error:", safeErrorCode(error));
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function retryUntilAvailable(operation, label) {
  let delayMs = 2_000;
  while (!shuttingDown) {
    try {
      return await operation();
    } catch (error) {
      const code = error?.error_code ?? error?.response?.error_code;
      if (code === 401 || code === 404) throw error;
      console.error(`[startup] ${label} unavailable:`, safeErrorCode(error));
      console.error(`[startup] retrying ${label} in ${Math.ceil(delayMs / 1000)} seconds`);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 60_000);
    }
  }
  throw new Error(`Startup cancelled while waiting for ${label}.`);
}

async function closeHttpServer() {
  if (!healthServer?.listening) return;
  await new Promise((resolve) => {
    healthServer.close(() => resolve());
    healthServer.closeIdleConnections?.();
  });
}

async function shutdown(signal = "shutdown") {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  runtimeHealth.setShuttingDown(true);
  console.log(`[shutdown] ${signal}: stopping PROFINO services`);

  shutdownPromise = (async () => {
    const schedulerDrained = scheduler?.stop();
    healthMonitor?.stop();

    try {
      bot.stop();
    } catch (error) {
      console.error("[shutdown] Telegram bot stop warning:", safeErrorCode(error));
    }

    await Promise.all([closeHttpServer(), schedulerDrained]);

    try {
      await closeDatabase();
      console.log("[shutdown] PostgreSQL pool closed.");
    } catch (error) {
      console.error("[shutdown] PostgreSQL pool close failed:", safeErrorCode(error));
    }
  })();

  return shutdownPromise;
}

registerCommands(bot);

bot.catch((error) => {
  console.error("[bot] update handler error:", safeErrorCode(error.error ?? error));
});

async function sendStartupReport(botUsername) {
  try {
    let schemaSnapshot = null;
    let schemaError = null;

    try {
      schemaSnapshot = await inspectCoreSchema(pool);
    } catch (error) {
      schemaError = safeErrorCode(error);
      console.error("[health] database schema inspection failed:", schemaError);
    }

    const report = formatStartupHealthReport({
      botUsername,
      mode,
      nodeVersion: process.version,
      databaseConnected: true,
      schemaSnapshot,
      schemaError
    });

    await bot.api.sendMessage(ADMIN_ID, report);
    console.log("[health] startup report delivered to Super Admin.");
  } catch (error) {
    console.error(
      "[health] startup report could not be delivered:",
      safeErrorCode(error)
    );
  }
}

async function startPolling() {
  let backoffMs = 2_000;

  while (!shuttingDown) {
    const startedAt = Date.now();

    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
      console.log("[bot] starting Telegram long polling");
      await bot.start({
        onStart: () => {
          runtimeHealth.setTelegramReceiverActive(true);
          console.log("[bot] Telegram polling is active; updates can be received.");
        }
      });

      runtimeHealth.setTelegramReceiverActive(false);
      if (!shuttingDown) {
        throw new Error("Telegram polling stopped unexpectedly.");
      }
    } catch (error) {
      runtimeHealth.setTelegramReceiverActive(false);
      if (shuttingDown) break;

      const code = error?.error_code ?? error?.response?.error_code;
      explainTelegramError(error);

      if (code === 401 || code === 404) {
        throw new Error("Telegram authentication/configuration failed.", { cause: error });
      }

      if (Date.now() - startedAt >= 60_000) {
        backoffMs = 2_000;
      }

      const delay = Math.min(backoffMs, 120_000);
      console.error(`[bot] polling will retry in ${Math.ceil(delay / 1000)} seconds`);
      await sleep(delay);
      backoffMs = Math.min(backoffMs * 2, 120_000);
    }
  }
}

async function main() {
  healthServer = await startHealthHttpServer({
    port,
    runtimeHealth,
    getBotUsername: () => botUsername,
    webhookPath: webhookUrl ? new URL(webhookUrl).pathname : "/telegram",
    getWebhookHandler: () => webhookHandler
  });

  const dbResult = await retryUntilAvailable(
    testDatabaseConnection,
    "PostgreSQL connection"
  );
  runtimeHealth.setDatabaseReady(true);
  console.log("[database] PostgreSQL connected successfully.");
  console.log("[database] server time:", dbResult.server_time);

  await ensurePostHistorySchema();
  console.log("[post-history] schema and audit trigger ready.");
  await ensureAdminOpsSchema();
  console.log("[admin-ops] audit log schema ready.");

  const me = await retryUntilAvailable(() => bot.api.getMe(), "Telegram API authentication");
  botUsername = me.username;
  runtimeHealth.setTelegramApiConnected(true);
  console.log(`[bot] authenticated as @${me.username} (${mode} mode)`);

  await sendStartupReport(me.username);
  // Nonblocking, metadata-only diagnostic delivered to the existing Super Admin.
  void deliverAdminSchemaAudit({
    pool,
    adminId:ADMIN_ID,
    sendMessage:(id,message)=>bot.api.sendMessage(id,message),
    logCode:(code)=>console.error("[deposit-audit] read-only inspection unavailable:",code)
  });

  healthMonitor = startHealthMonitor({
    bot,
    pool,
    telegramCheck: mode === "webhook"
      ? async () => {
          const info = await bot.api.getWebhookInfo();
          return info.url === webhookUrl;
        }
      : async () => { await bot.api.getMe(); return true; },
    onStatus: (status) => {
      runtimeHealth.setTelegramApiConnected(status.telegram);
      runtimeHealth.setDatabaseReady(status.database);
    }
  });

  scheduler = startScheduler(bot);

  if (mode === "webhook") {
    const secret = webhookSecret;
    webhookHandler = webhookCallback(bot, "http", { secretToken: secret });

    await retryUntilAvailable(() => bot.api.setWebhook(webhookUrl, {
      secret_token: secret,
      drop_pending_updates: false
    }), "Telegram webhook registration");

    runtimeHealth.setTelegramReceiverActive(true);
    console.log("[bot] webhook registered");
    return;
  }

  await startPolling();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      console.error("[shutdown] failed:", safeErrorCode(error));
      process.exitCode = 1;
    });
  });
}

main().catch(async (error) => {
  console.error("[startup] PROFINO could not start:", safeErrorCode(error));
  process.exitCode = 1;
  await shutdown("startup failure");
});
