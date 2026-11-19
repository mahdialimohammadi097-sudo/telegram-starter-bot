import { openSimulatedInvestment } from "../test-support/simulated-investment.js";
import {
  reserveWithdrawal, cancelWithdrawal, listReservedWithdrawals,
  simulationWithdrawalReview
} from "../test-support/simulated-withdrawal.js";

// Never activate synthetic writers in an ordinary production deployment.
// The database itself must also be explicitly marked as isolated staging.
export async function createStagingSimulationHandlers(pool, env = process.env, authenticatedBotUsername = null) {
  if (env.PROFINO_SIMULATION_MODE !== "isolated-staging") return {};
  if (env.PROFINO_DEPLOYMENT_ENV !== "staging") {
    throw new Error("Simulation requires explicit staging deployment");
  }
  const expectedBot = String(env.PROFINO_STAGING_BOT_USERNAME || "").replace(/^@/, "").trim();
  if (!expectedBot || !authenticatedBotUsername ||
      expectedBot.toLowerCase() !== String(authenticatedBotUsername).toLowerCase() ||
      expectedBot.toLowerCase() === "profino1bot") {
    throw new Error("Simulation requires a separate authenticated staging Telegram bot");
  }
  const expectedDatabase = String(env.PROFINO_STAGING_DATABASE_NAME || "").trim();
  if (!expectedDatabase || expectedDatabase.toLowerCase() === "profino-db") {
    throw new Error("Simulation requires an explicitly named staging database");
  }
  const { rows: [marker] } = await pool.query(
    "SELECT current_setting('profino.environment', true) AS environment, current_database() AS database_name"
  );
  if (marker?.environment !== "isolated-staging" || marker.database_name !== expectedDatabase) {
    throw new Error("Simulation requires an independently marked isolated staging database");
  }
  const { rows } = await pool.query(
    `SELECT to_regclass('simulation_investments') IS NOT NULL AS investments,
            to_regclass('simulation_withdrawals') IS NOT NULL AS withdrawals,
            to_regclass('simulation_reviewers') IS NOT NULL AS reviewers`
  );
  if (!rows[0]?.investments || !rows[0]?.withdrawals || !rows[0]?.reviewers) {
    throw new Error("Staging simulation tables are missing; run isolated staging setup");
  }
  return {
    openTestInvestment: (userId, key, selection) =>
      openSimulatedInvestment(pool, userId, key, selection),
    reserveTestWithdrawal: (userId, key, amount) =>
      reserveWithdrawal(pool, userId, key, amount),
    cancelTestWithdrawal: (userId, id) => cancelWithdrawal(pool, userId, id),
    listTestHolds: userId => listReservedWithdrawals(pool, userId),
    testWithdrawalReview: simulationWithdrawalReview(pool)
  };
}
