import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeHealthState } from "./runtime-health.js";

test("readiness requires PostgreSQL, Telegram API, and an active update receiver", () => {
  const health = createRuntimeHealthState();
  assert.equal(health.snapshot().ready, false);
  health.setDatabaseReady(true);
  health.setTelegramApiConnected(true);
  assert.equal(health.snapshot().ready, false);
  health.setTelegramReceiverActive(true);
  assert.deepEqual(health.snapshot(), {
    ready: true,
    database: "connected",
    telegram: "connected",
    telegramApi: "connected",
    telegramReceiver: "active",
    shuttingDown: false
  });
});

test("API availability alone does not falsely mark polling as ready", () => {
  const health = createRuntimeHealthState();
  health.setDatabaseReady(true);
  health.setTelegramApiConnected(true);
  assert.equal(health.snapshot().ready, false);
  health.setTelegramReceiverActive(true);
  health.setTelegramApiConnected(false);
  assert.equal(health.snapshot().ready, false);
});

test("readiness becomes false immediately when PostgreSQL fails", () => {
  const health = createRuntimeHealthState();
  health.setDatabaseReady(true);
  health.setTelegramApiConnected(true);
  health.setTelegramReceiverActive(true);
  health.setDatabaseReady(false);
  assert.equal(health.snapshot().ready, false);
});

test("readiness is false during graceful shutdown", () => {
  const health = createRuntimeHealthState();
  health.setDatabaseReady(true);
  health.setTelegramApiConnected(true);
  health.setTelegramReceiverActive(true);
  health.setShuttingDown(true);
  assert.equal(health.snapshot().ready, false);
  assert.equal(health.snapshot().shuttingDown, true);
});
