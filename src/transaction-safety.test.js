import test from "node:test";
import assert from "node:assert/strict";
import { rollbackTransaction } from "./transaction-safety.js";

test("returns no discard error after a successful rollback", async () => {
  const calls = [];
  const client = { async query(sql) { calls.push(sql); return { command: sql }; } };
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

test("frozen original errors cannot prevent discarding the broken client", async () => {
  const original = Object.freeze(new Error("operation failed"));
  const rollbackFailure = new Error("rollback failed");
  assert.equal(await rollbackTransaction({ async query() { throw rollbackFailure; } }, original), rollbackFailure);
});
test("non-Error rollback failures still require client discard", async () => {
  assert.ok(await rollbackTransaction({ async query() { throw null; } }, null) instanceof Error);
});

for (const result of [undefined, null, {}, { command: "COMMIT" }, [{ command: "ROLLBACK" }]]) {
  test("discards a client after an unconfirmed rollback: " + JSON.stringify(result), async () => {
    const original = new Error("operation failed");
    const calls = [];
    const discard = await rollbackTransaction({ async query(sql) { calls.push(sql); return result; } }, original);
    assert.ok(discard instanceof Error);
    assert.match(discard.message, /rollback unconfirmed/);
    assert.equal(original.rollbackError, discard);
    assert.deepEqual(calls, ["ROLLBACK"]);
  });
}
