import test from "node:test";
import assert from "node:assert/strict";
import { runReadOnlyDepositAudit } from "./read-only-deposit-audit.js";

function fixture(failRollback = false) {
  const queries = [], releases = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === "ROLLBACK" && failRollback) throw new Error("synthetic rollback failure");
    },
    release(error) { releases.push(error); }
  };
  return { client, queries, releases, pool: { connect: async () => client } };
}

test("deposit audit uses one bounded read-only repeatable snapshot", async () => {
  const f = fixture();
  assert.deepEqual(await runReadOnlyDepositAudit(f.pool, async client => {
    assert.equal(client, f.client);
    await client.query("SELECT 1");
    return { ready: true };
  }), { ready: true });
  assert.deepEqual(f.queries, [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SET LOCAL statement_timeout = '10s'",
    "SET LOCAL lock_timeout = '3s'", "SELECT 1", "COMMIT"
  ]);
  assert.deepEqual(f.releases, [undefined]);
});

test("failed inspection rolls back and preserves the original error", async () => {
  const f = fixture();
  const original = new Error("synthetic inspection failure");
  await assert.rejects(runReadOnlyDepositAudit(f.pool, async () => { throw original; }), e => e === original);
  assert.equal(f.queries.at(-1), "ROLLBACK");
  assert.deepEqual(f.releases, [undefined]);
});

test("failed rollback discards connection even when original error is frozen", async () => {
  const f = fixture(true);
  const original = Object.freeze(new Error("synthetic inspection failure"));
  await assert.rejects(runReadOnlyDepositAudit(f.pool, async () => { throw original; }), e => e === original);
  assert.equal(f.releases.length, 1);
  assert.ok(f.releases[0] instanceof Error);
});
