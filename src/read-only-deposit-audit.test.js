import test from "node:test";
import assert from "node:assert/strict";
import { runReadOnlyDepositAudit } from "./read-only-deposit-audit.js";

function fixture(failRollback = false, { completion = "COMMIT", beginError, beginTag = "BEGIN", setTag = "SET", settings = {read_only:"on",isolation:"repeatable read",statement_timeout:"10s",lock_timeout:"3s"} } = {}) {
  const queries = [], releases = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" && beginError) throw beginError;
      if (sql === "ROLLBACK" && failRollback) throw new Error("synthetic rollback failure");
      if (sql.startsWith("BEGIN")) return {command:beginTag};
      if (sql.startsWith("SET LOCAL")) return {command:setTag};
      if (sql.includes("pg_catalog.current_setting('transaction_read_only')")) return {rows:[settings]};
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
    "SET LOCAL lock_timeout = '3s'",
    `SELECT pg_catalog.current_setting('transaction_read_only') AS read_only,
      pg_catalog.current_setting('transaction_isolation') AS isolation,
      pg_catalog.current_setting('statement_timeout') AS statement_timeout,
      pg_catalog.current_setting('lock_timeout') AS lock_timeout`, "SELECT 1", "COMMIT"
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

test("audit discards connection after unconfirmed BEGIN without reading data",async()=>{
 const f=fixture(false,{beginTag:"SELECT"});
 await assert.rejects(runReadOnlyDepositAudit(f.pool,async()=>assert.fail("inspection must not run")),/start unconfirmed/);
 assert.deepEqual(f.queries,["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
 assert.ok(f.releases[0] instanceof Error);
});
test("audit rejects an unconfirmed time limit before reading data",async()=>{
 const f=fixture(false,{setTag:null});
 await assert.rejects(runReadOnlyDepositAudit(f.pool,async()=>assert.fail("inspection must not run")),/time limits unconfirmed/);
 assert.equal(f.queries.at(-1),"ROLLBACK");
});
for(const settings of [
 {read_only:"off",isolation:"repeatable read",statement_timeout:"10s",lock_timeout:"3s"},
 {read_only:"on",isolation:"read committed",statement_timeout:"10s",lock_timeout:"3s"},
 {read_only:"on",isolation:"repeatable read",statement_timeout:"0",lock_timeout:"3s"},
 {read_only:"on",isolation:"repeatable read",statement_timeout:"10s",lock_timeout:"0"},
 {}
]){
 test("audit refuses mismatched effective transaction settings "+JSON.stringify(settings),async()=>{
  const f=fixture(false,{settings});
  await assert.rejects(runReadOnlyDepositAudit(f.pool,async()=>assert.fail("inspection must not run")),/settings incompatible/);
  assert.equal(f.queries.at(-1),"ROLLBACK");
 });
}
