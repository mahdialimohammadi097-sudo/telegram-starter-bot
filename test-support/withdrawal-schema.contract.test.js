import test from "node:test";
import assert from "node:assert/strict";
import { createSimulationWithdrawalTables } from "./withdrawal-schema.js";

test("integrated synthetic withdrawal schema preserves four-state payout and replay contract", async () => {
  const statements = [];
  const pool = { async query(sql) { statements.push(sql); return { rows: [] }; } };
  await createSimulationWithdrawalTables(pool);
  assert.equal(statements.length, 2);
  const ddl = statements[1];
  for (const state of ["reserved", "cancelled", "pending_receipt", "paid"]) {
    assert.match(ddl, new RegExp("'"+state+"'"));
  }
  for (const column of [
    "submitted_hash", "simulation_payload", "destination", "payout_event",
    "payout_id", "clearing_id", "cancelled_by_reviewer", "release_id"
  ]) assert.match(ddl, new RegExp("\\b"+column+"\\b"));
  assert.match(ddl, /UNIQUE\s*\(user_id,\s*request_key\)/i);
  assert.match(ddl, /submitted_hash\s+text\s+UNIQUE/i);
  assert.match(ddl, /payout_event\s+text\s+UNIQUE/i);
  assert.match(ddl, /CHECK\s*\(\(status\s+IN\s*\('pending_receipt',\s*'paid'\)\)\s*=\s*\(submitted_hash\s+IS\s+NOT\s+NULL\)\)/i);
  assert.match(ddl, /\(status\s*=\s*'paid'\)\s*=\s*\(payout_event\s+IS\s+NOT\s+NULL\)/i);
  assert.match(ddl, /\(status\s*=\s*'paid'\)\s*=\s*\(payout_id\s+IS\s+NOT\s+NULL\)/i);
  assert.match(ddl, /\(status\s*=\s*'paid'\)\s*=\s*\(clearing_id\s+IS\s+NOT\s+NULL\)/i);
});
