import { isolatedDatabaseIdentitySql, isIsolatedDatabaseIdentity } from "./isolated-database-identity.js";
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
  if (!/(?:^|_)(?:staging|test|sandbox)(?:_|$)/i.test(expectedDatabase)) {
    throw new Error("Simulation database name must visibly identify an isolated test environment");
  }
  const { rows: [marker] } = await pool.query(isolatedDatabaseIdentitySql);
  if (!isIsolatedDatabaseIdentity(marker, expectedDatabase)) {
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
  const compatibility = await inspectStagingWithdrawalSchema(pool);
  if (compatibility?.extended_columns !== true || compatibility.payout_state_constraint !== true) {
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

// A constraint merely mentioning the four names or marked NOT VALID does
// not prove the reviewed state restriction.
export async function inspectStagingWithdrawalSchema(pool) {
  const {rows}=await pool.query(`
    WITH target AS (
      SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.oid=pg_catalog.to_regclass('simulation_withdrawals')
        AND n.nspname=pg_catalog.current_schema() AND c.relkind='r' AND c.relpersistence='p'
    ), expected(name,type) AS (VALUES
      ('submitted_hash','text'),('simulation_payload','bytea'),('destination','text'),
      ('payout_event','text'),('payout_id','bigint'),('clearing_id','bigint'),('status','text')
    )
    SELECT EXISTS (
      SELECT 1 FROM target t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid
      JOIN expected e ON a.attname=e.name AND pg_catalog.format_type(a.atttypid,a.atttypmod)=e.type
      WHERE a.attnum>0 AND NOT a.attisdropped AND (e.name<>'status' OR a.attnotnull)
      GROUP BY t.oid HAVING COUNT(*) = 7
    ) AS extended_columns,
    EXISTS (
      SELECT 1 FROM target t JOIN pg_catalog.pg_constraint c ON c.conrelid=t.oid
      JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attname='status'
      WHERE c.contype='c' AND c.convalidated AND c.conkey=ARRAY[a.attnum]::smallint[]
        AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(c.conbin,c.conrelid),'[[:space:]()]','','g') =
          'status=ANYARRAY[''reserved''::text,''cancelled''::text,''pending_receipt''::text,''paid''::text]'
    ) AS payout_state_constraint
  `);
  if(rows?.length!==1)throw new Error("Incompatible staging withdrawal schema; migration review required");
  return rows[0];
}
