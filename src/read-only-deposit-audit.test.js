import test from "node:test";
import assert from "node:assert/strict";
import { runReadOnlyDepositAudit } from "./read-only-deposit-audit.js";

function fixture(failRollback = false, { completion = "COMMIT", beginError } = {}) {
  const queries = [], releases = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" && beginError) throw beginError;
      if (sql === "ROLLBACK" && failRollback) throw new Error("synthetic rollback failure");
      return { command: sql === "COMMIT" ? completion : sql };
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

test("audit never returns a readiness report for a rolled-back transaction", async () => {
  const f = fixture(false, { completion: "ROLLBACK" });
  await assert.rejects(runReadOnlyDepositAudit(f.pool, async () => ({ ready: true })), /did not commit/);
  assert.equal(f.queries.at(-1), "COMMIT");
  assert.equal(f.releases.length, 1);
  assert.ok(f.releases[0] instanceof Error);
});

test("failed BEGIN discards the client and never runs the inspection", async () => {
  const original = new Error("synthetic BEGIN failure");
  const f = fixture(false, { beginError: original });
  await assert.rejects(runReadOnlyDepositAudit(f.pool, async () => assert.fail("inspection must not run")), e => e === original);
  assert.deepEqual(f.queries, ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
  assert.deepEqual(f.releases, [original]);
});
