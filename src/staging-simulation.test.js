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
      PROFINO_SIMULATION_MODE: "isolated-staging", PROFINO_DEPLOYMENT_ENV: "staging"
    }), /independently marked isolated staging database/
  );
});

test("simulation refuses incomplete staging schema", async () => {
  const pool = { async query(sql) {
    return { rows: sql.includes("current_setting")
      ? [{ environment: "isolated-staging" }]
      : [{ investments: true, withdrawals: false, reviewers: true }] };
  } };
  await assert.rejects(
    createStagingSimulationHandlers(pool, {
      PROFINO_SIMULATION_MODE: "isolated-staging", PROFINO_DEPLOYMENT_ENV: "staging"
    }), /tables are missing/
  );
});

test("fully marked isolated staging exposes synthetic writers", async () => {
  const pool = { async query(sql) {
    return { rows: sql.includes("current_setting")
      ? [{ environment: "isolated-staging" }]
      : [{ investments: true, withdrawals: true, reviewers: true }] };
  } };
  const handlers = await createStagingSimulationHandlers(pool, {
    PROFINO_SIMULATION_MODE: "isolated-staging", PROFINO_DEPLOYMENT_ENV: "staging"
  });
  for (const key of ["openTestInvestment", "reserveTestWithdrawal",
    "cancelTestWithdrawal", "listTestHolds"]) {
    assert.equal(typeof handlers[key], "function");
  }
  assert.equal(typeof handlers.testWithdrawalReview.release, "function");
});
