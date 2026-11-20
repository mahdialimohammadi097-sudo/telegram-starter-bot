// Read-only isolated staging preflight. No schema creation, Telegram messages or money movement.
import { Bot } from "grammy";
import { pool, closeDatabase } from "../src/database.js";
import { createStagingSimulationHandlers } from "../src/staging-simulation.js";

async function main() {
  const env = process.env;
  if (env.PROFINO_SIMULATION_MODE !== "isolated-staging" ||
      env.PROFINO_DEPLOYMENT_ENV !== "staging" ||
      !env.PROFINO_STAGING_BOT_USERNAME ||
      !env.PROFINO_STAGING_DATABASE_NAME) {
    throw new Error("Missing explicit isolated staging environment settings");
  }
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Missing staging Telegram bot token");
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  const me = await bot.api.getMe();
  const handlers = await createStagingSimulationHandlers(pool, env, me.username);
  if (typeof handlers.openTestInvestment !== "function" ||
      typeof handlers.reserveTestWithdrawal !== "function" ||
      typeof handlers.testWithdrawalReview?.release !== "function") {
    throw new Error("Staging simulation handlers not ready");
  }
  console.log("PASS: isolated staging Telegram bot and database validated; simulation handlers ready.");
  console.log("No messages, schema changes, funds, or financial transactions were created.");
}

try {
  await main();
} catch {
  console.error("FAIL: staging preflight did not pass; check isolated staging configuration and schema.");
  process.exitCode = 1;
} finally {
  await closeDatabase().catch(() => { process.exitCode = 1; });
}
