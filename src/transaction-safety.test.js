import test from "node:test";
import assert from "node:assert/strict";
import { rollbackTransaction } from "./transaction-safety.js";

test("returns no discard error after a successful rollback", async () => {
  const calls = [];
  const client = { async query(sql) { calls.push(sql); } };
  const original = new Error("posting failed");

  assert.equal(await rollbackTransaction(client, original), null);
  assert.deepEqual(calls, ["ROLLBACK"]);
  assert.equal(original.rollbackError, undefined);
});

test("preserves the original error and returns rollback failure for client discard", async () => {
  const rollbackFailure = new Error("connection lost during rollback");
  const client = { async query() { throw rollbackFailure; } };
  const original = new Error("status update failed");

  assert.equal(await rollbackTransaction(client, original), rollbackFailure);
  assert.equal(original.rollbackError, rollbackFailure);
});
