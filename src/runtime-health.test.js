import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeHealthState } from "./runtime-health.js";

test("readiness stays false until both PostgreSQL and Telegram are ready", () => {
  const health = createRuntimeHealthState();
  assert.equal(health.snapshot().ready, false);

  health.setDatabaseReady(true);
  assert.equal(health.snapshot().ready, false);

  health.setTelegramReady(true);
  assert.deepEqual(health.snapshot(), {
    ready: true,
    database: "connected",
    telegram: "connected",
    shuttingDown: false
  });
});

test("readiness becomes false immediately when a dependency fails", () => {
  const health = createRuntimeHealthState();
  health.setDatabaseReady(true);
  health.setTelegramReady(true);
  health.setTelegramReady(false);
  assert.equal(health.snapshot().ready, false);
  assert.equal(health.snapshot().telegram, "unavailable");
});

test("readiness is false during graceful shutdown", () => {
  const health = createRuntimeHealthState();
  health.setDatabaseReady(true);
  health.setTelegramReady(true);
  health.setShuttingDown(true);
  assert.equal(health.snapshot().ready, false);
  assert.equal(health.snapshot().shuttingDown, true);
});
