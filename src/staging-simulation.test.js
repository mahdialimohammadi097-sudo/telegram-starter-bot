import test from "node:test";
import assert from "node:assert/strict";
import { createStagingSimulationHandlers } from "./staging-simulation.js";

test("simulation writers are disabled by default without querying database", async () => {
  const pool = { query() { throw new Error("must not query"); } };
  assert.deepEqual(await createStagingSimulationHandlers(pool, {}), {});
});

test("simulation refuses non-staging deployment before database access", async () => {
  const pool = { query() { throw new Error("must not query"); } };
  await assert.rejects(
    createStagingSimulationHandlers(pool, { PROFINO_SIMULATION_MODE: "isolated-staging" }),
    /explicit staging deployment/
  );
});

test("simulation refuses database without isolated staging marker", async () => {
  const pool = { async query() { return { rows: [{ environment: null }] }; } };
  await assert.rejects(
    createStagingSimulationHandlers(pool, {
      PROFINO_SIMULATION_MODE: "isolated-staging", PROFINO_DEPLOYMENT_ENV: "staging", PROFINO_STAGING_BOT_USERNAME: "profino_staging_test_bot", PROFINO_STAGING_DATABASE_NAME: "profino_staging_it"
    }, "profino_staging_test_bot"), /independently marked isolated staging database/
  );
});

test("simulation refuses incomplete staging schema", async () => {
  const pool = { async query(sql) {
    return { rows: sql.includes("current_setting")
      ? [{ environment: "isolated-staging", database_name: "profino_staging_it" }]
      : [{ investments: true, withdrawals: false, reviewers: true }] };
  } };
  await assert.rejects(
    createStagingSimulationHandlers(pool, {
      PROFINO_SIMULATION_MODE: "isolated-staging", PROFINO_DEPLOYMENT_ENV: "staging", PROFINO_STAGING_BOT_USERNAME: "profino_staging_test_bot", PROFINO_STAGING_DATABASE_NAME: "profino_staging_it"
    }, "profino_staging_test_bot"), /tables are missing/
  );
});

test("fully marked isolated staging exposes synthetic writers", async () => {
  const pool = { async query(sql) {
    return { rows: sql.includes("current_setting")
      ? [{ environment: "isolated-staging", database_name: "profino_staging_it" }]
      : sql.includes("pg_attribute")
        ? [{ extended_columns: true, payout_state_constraint: true }]
        : [{ investments: true, withdrawals: true, reviewers: true }] };
  } };
  const handlers = await createStagingSimulationHandlers(pool, {
    PROFINO_SIMULATION_MODE: "isolated-staging", PROFINO_DEPLOYMENT_ENV: "staging", PROFINO_STAGING_BOT_USERNAME: "profino_staging_test_bot", PROFINO_STAGING_DATABASE_NAME: "profino_staging_it"
  }, "profino_staging_test_bot");
  for (const key of ["openTestInvestment", "reserveTestWithdrawal",
    "cancelTestWithdrawal", "listTestHolds"]) {
    assert.equal(typeof handlers[key], "function");
  }
  assert.equal(typeof handlers.testWithdrawalReview.release, "function");
});

test("simulation rejects production bot and mismatched bot identity", async () => {
  const pool = { query() { throw new Error("must not query"); } };
  const env = { PROFINO_SIMULATION_MODE: "isolated-staging", PROFINO_DEPLOYMENT_ENV: "staging", PROFINO_STAGING_BOT_USERNAME: "profino_staging_test_bot", PROFINO_STAGING_DATABASE_NAME: "profino_staging_it" };
  await assert.rejects(createStagingSimulationHandlers(pool, env, "PROFINO1bot"), /Production Telegram bot cannot activate simulation writers/);
  await assert.rejects(createStagingSimulationHandlers(pool, env, "other_bot"), /separate authenticated staging Telegram bot/);
  await assert.rejects(createStagingSimulationHandlers(pool, { ...env, PROFINO_STAGING_BOT_USERNAME: "PROFINO1bot" }, "PROFINO1bot"), /Production Telegram bot cannot activate simulation writers/);
});

test("simulation rejects wrong staging database identity before enabling writers", async () => {
  const pool = { async query() { return { rows: [{ environment: "isolated-staging", database_name: "profino_production" }] }; } };
  const env = { PROFINO_SIMULATION_MODE: "isolated-staging", PROFINO_DEPLOYMENT_ENV: "staging", PROFINO_STAGING_BOT_USERNAME: "profino_staging_test_bot", PROFINO_STAGING_DATABASE_NAME: "profino_staging_it" };
  await assert.rejects(createStagingSimulationHandlers(pool, env, "profino_staging_test_bot"), /independently marked isolated staging database/);
  await assert.rejects(createStagingSimulationHandlers(pool, { ...env, PROFINO_STAGING_DATABASE_NAME: "profino-db" }, "profino_staging_test_bot"), /explicitly named staging database/);
});

test("simulation refuses legacy withdrawal schema lacking payout state", async () => {
  const pool = { async query(sql) {
    if (sql.includes("current_setting")) return { rows: [{ environment: "isolated-staging", database_name: "profino_staging_it" }] };
    if (sql.includes("to_regclass")) return { rows: [{ investments: true, withdrawals: true, reviewers: true }] };
    return { rows: [{ extended_columns: false, payout_state_constraint: false }] };
  } };
  await assert.rejects(createStagingSimulationHandlers(pool, {
    PROFINO_SIMULATION_MODE: "isolated-staging", PROFINO_DEPLOYMENT_ENV: "staging",
    PROFINO_STAGING_BOT_USERNAME: "profino_staging_test_bot", PROFINO_STAGING_DATABASE_NAME: "profino_staging_it"
  }, "profino_staging_test_bot"), /Incompatible staging withdrawal schema/);
});

test("simulation refuses extended columns without a four-state payout constraint", async () => {
  const pool = { async query(sql) {
    if (sql.includes("current_setting")) return { rows: [{ environment: "isolated-staging", database_name: "profino_staging_it" }] };
    if (sql.includes("to_regclass")) return { rows: [{ investments: true, withdrawals: true, reviewers: true }] };
    return { rows: [{ extended_columns: true, payout_state_constraint: false }] };
  } };
  await assert.rejects(createStagingSimulationHandlers(pool, {
    PROFINO_SIMULATION_MODE: "isolated-staging", PROFINO_DEPLOYMENT_ENV: "staging",
    PROFINO_STAGING_BOT_USERNAME: "profino_staging_test_bot", PROFINO_STAGING_DATABASE_NAME: "profino_staging_it"
  }, "profino_staging_test_bot"), /Incompatible staging withdrawal schema/);
});

test("simulation refuses payout constraint when required columns are missing", async () => {
  const pool = { async query(sql) {
    if (sql.includes("current_setting")) return { rows: [{ environment: "isolated-staging", database_name: "profino_staging_it" }] };
    if (sql.includes("to_regclass")) return { rows: [{ investments: true, withdrawals: true, reviewers: true }] };
    return { rows: [{ extended_columns: false, payout_state_constraint: true }] };
  } };
  await assert.rejects(createStagingSimulationHandlers(pool, {
    PROFINO_SIMULATION_MODE: "isolated-staging", PROFINO_DEPLOYMENT_ENV: "staging",
    PROFINO_STAGING_BOT_USERNAME: "profino_staging_test_bot", PROFINO_STAGING_DATABASE_NAME: "profino_staging_it"
  }, "profino_staging_test_bot"), /Incompatible staging withdrawal schema/);
});

test("staging schema preflight checks every supported withdrawal state", async () => {
  let checkedConstraint = false;
  const pool = { async query(sql) {
    if (sql.includes("current_setting")) return { rows: [{ environment: "isolated-staging", database_name: "profino_staging_it" }] };
    if (sql.includes("to_regclass")) return { rows: [{ investments: true, withdrawals: true, reviewers: true }] };
    for (const state of ["reserved", "cancelled", "pending_receipt", "paid"]) {
      assert.ok(sql.includes(`LIKE '%${state}%'`), `missing constraint check for ${state}`);
    }
    checkedConstraint = true;
    return { rows: [{ extended_columns: true, payout_state_constraint: true }] };
  } };
  const handlers = await createStagingSimulationHandlers(pool, {
    PROFINO_SIMULATION_MODE: "isolated-staging", PROFINO_DEPLOYMENT_ENV: "staging",
    PROFINO_STAGING_BOT_USERNAME: "profino_staging_test_bot", PROFINO_STAGING_DATABASE_NAME: "profino_staging_it"
  }, "profino_staging_test_bot");
  assert.equal(checkedConstraint, true);
  assert.equal(typeof handlers.reserveTestWithdrawal, "function");
});
