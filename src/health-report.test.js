import test from "node:test";
import assert from "node:assert/strict";
import { formatStartupHealthReport } from "./health-report.js";

test("reports a healthy startup and complete core table inventory", () => {
  const report = formatStartupHealthReport({
    botUsername: "PROFINO1bot",
    mode: "polling",
    nodeVersion: "v26.0.0",
    databaseConnected: true,
    schemaSnapshot: {
      expectedTables: ["users", "ledger_entries"],
      existingTables: ["users", "ledger_entries"],
      tableInventory: ["users", "ledger_entries", "admin_audit_logs"],
      indexes: [{ indexname: "users_pkey" }],
      triggers: [{ trigger_name: "ledger_guard" }]
    },
    checkedAt: new Date("2026-11-10T12:00:00.000Z")
  });

  assert.match(report, /Telegram bot: CONNECTED \(@PROFINO1bot\)/);
  assert.match(report, /PostgreSQL: CONNECTED/);
  assert.match(report, /CORE TABLES PRESENT/);
  assert.match(report, /Tables: 2\/2 expected core tables found/);
  assert.match(report, /No balances, transactions, users, or schema were changed/);
});

test("flags missing expected tables without exposing database contents", () => {
  const report = formatStartupHealthReport({
    botUsername: "PROFINO1bot",
    mode: "polling",
    nodeVersion: "v26.0.0",
    databaseConnected: true,
    schemaSnapshot: {
      expectedTables: ["users", "ledger_entries"],
      existingTables: ["users"],
      tableInventory: ["users"],
      indexes: [],
      triggers: []
    }
  });

  assert.match(report, /ATTENTION REQUIRED/);
  assert.match(report, /Missing core tables: ledger_entries/);
});

test("reports a schema inspection failure safely", () => {
  const report = formatStartupHealthReport({
    botUsername: "PROFINO1bot",
    mode: "webhook",
    nodeVersion: "v26.0.0",
    databaseConnected: true,
    schemaError: "42P01"
  });

  assert.match(report, /Database schema inspection: FAILED/);
  assert.match(report, /Diagnostic code: 42P01/);
  assert.doesNotMatch(report, /DATABASE_URL|password|postgres:\/\//i);
});
