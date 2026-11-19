import { openSimulatedInvestment } from "../test-support/simulated-investment.js";
import {
  reserveWithdrawal, cancelWithdrawal, listReservedWithdrawals,
  simulationWithdrawalReview
} from "../test-support/simulated-withdrawal.js";

// Never activate synthetic writers in an ordinary production deployment.
// The database itself must also be explicitly marked as isolated staging.
export async function createStagingSimulationHandlers(pool, env = process.env) {
  if (env.PROFINO_SIMULATION_MODE !== "isolated-staging") return {};
  if (env.PROFINO_DEPLOYMENT_ENV !== "staging") {
    throw new Error("Simulation requires explicit staging deployment");
  }
  const { rows: [marker] } = await pool.query(
    "SELECT current_setting('profino.environment', true) AS environment"
  );
  if (marker?.environment !== "isolated-staging") {
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
