import { openSimulatedInvestment } from "../test-support/simulated-investment.js";
import {
  reserveWithdrawal, cancelWithdrawal, listReservedWithdrawals,
  simulationWithdrawalReview
} from "../test-support/simulated-withdrawal.js";

// Never activate synthetic writers in an ordinary production deployment.
// The database itself must also be explicitly marked as isolated staging.
export async function createStagingSimulationHandlers(pool, env = process.env, authenticatedBotUsername = null) {
  if (env.PROFINO_SIMULATION_MODE !== "isolated-staging") return {};
  // A production bot is never a staging simulator, regardless of its environment labels.
  if (String(authenticatedBotUsername || "").toLowerCase() === "profino1bot") {
    throw new Error("Production Telegram bot cannot activate simulation writers");
  }
  if (env.PROFINO_DEPLOYMENT_ENV !== "staging") {
    throw new Error("Simulation requires explicit staging deployment");
  }
  const expectedBot = String(env.PROFINO_STAGING_BOT_USERNAME || "").replace(/^@/, "").trim();
  if (!expectedBot || !authenticatedBotUsername ||
      expectedBot.toLowerCase() !== String(authenticatedBotUsername).toLowerCase() ||
      expectedBot.toLowerCase() === "profino1bot") {
    throw new Error("Simulation requires a separate authenticated staging Telegram bot");
  }
  const expectedDatabase = String(env.PROFINO_STAGING_DATABASE_NAME || "");
  // A staging database name must be distinct from the production database, not merely labeled staging.
  if (env.PROFINO_PRODUCTION_DATABASE_NAME &&
      expectedDatabase.toLowerCase() === String(env.PROFINO_PRODUCTION_DATABASE_NAME).trim().toLowerCase()) {
    throw new Error("Simulation staging database must differ from configured production database");
  }
  if (!expectedDatabase || expectedDatabase.toLowerCase() === "profino-db" ||
      !/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(expectedDatabase)) {
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
  // The older ledger review branch supports only reserved/cancelled. Refuse to
  // activate against that incompatible schema instead of silently losing payout state.
  const { rows: [compatibility] } = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'simulation_withdrawals'::regclass
        AND attname IN ('submitted_hash', 'simulation_payload', 'destination',
                        'payout_event', 'payout_id', 'clearing_id')
        AND attnum > 0 AND NOT attisdropped
      GROUP BY attrelid HAVING COUNT(*) = 6
    ) AS extended_columns,
    EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = 'simulation_withdrawals'::regclass
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%reserved%'
        AND pg_get_constraintdef(c.oid) LIKE '%cancelled%'
        AND pg_get_constraintdef(c.oid) LIKE '%pending_receipt%'
        AND pg_get_constraintdef(c.oid) LIKE '%paid%'
    ) AS payout_state_constraint
  `);
  if (!compatibility?.extended_columns || !compatibility.payout_state_constraint) {
    throw new Error("Incompatible staging withdrawal schema; migration review required");
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
