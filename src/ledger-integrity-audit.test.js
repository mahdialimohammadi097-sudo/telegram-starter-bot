import test from "node:test";
import assert from "node:assert/strict";
import { auditLedgerIntegrity } from "./ledger-integrity-audit.js";

function fakePool({ bad = false, fail = false } = {}) {
  const calls = [];
  const row = { journals:"2", posted_journals:"2", entries:"4", unresolved_journals:"0",
    missing_idempotency_keys:"0", duplicate_idempotency_keys:"0", invalid_entries:"0",
    unbalanced_posted_journals:"0", negative_customer_accounts:bad?"1":"0" };
  const client = { async query(sql) {
    calls.push(sql);
    if (sql.startsWith("BEGIN")) return { command:"BEGIN" };
    if (sql.startsWith("SET LOCAL")) return { command:"SET" };
    if (sql.startsWith("SELECT pg_catalog.current_setting")) return { rows:[{
      read_only:"on", isolation:"repeatable read", statement_timeout:"10s", lock_timeout:"3s" }] };
    if (sql.startsWith("SELECT current_setting")) return { rows:[{row_security:"off",search_path:"pg_catalog"}] };
    if (sql.includes("WITH journals")) return { rows:[fail?{...row, entries:4}:row] };
    if (sql==="COMMIT" || sql==="ROLLBACK") return {command:sql};
    throw Error("unexpected SQL");
  }, release(){ calls.push("RELEASE"); } };
  return { calls, pool:{ async connect(){return client;} } };
}
test("audit uses one read-only snapshot, count strings and never certifies custody",async()=>{
  const {pool,calls}=fakePool();
  const result=await auditLedgerIntegrity(pool);
  assert.equal(result.clean,true);
  assert.equal(result.custodyVerified,false);
  assert.equal(result.productionReady,false);
  assert.equal(result.counts.entries,"4");
  assert.ok(calls.some(q=>q.includes('"public".ledger_transactions')));
  assert.ok(calls.includes("SET LOCAL row_security = off"));
  assert.equal(calls.at(-2),"COMMIT");
});
test("audit reports discrepancies and rejects malformed count evidence",async()=>{
  const bad=fakePool({bad:true});
  assert.equal((await auditLedgerIntegrity(bad.pool)).clean,false);
  const invalid=fakePool({fail:true});
  await assert.rejects(auditLedgerIntegrity(invalid.pool),/Incomplete ledger integrity audit/);
  assert.equal(invalid.calls.at(-2),"ROLLBACK");
});
test("audit rejects unsafe schema identifiers before connecting",async()=>{
  const {pool,calls}=fakePool();
  await assert.rejects(auditLedgerIntegrity(pool,{schema:'public"; DROP TABLE x;--'}),/Invalid ledger audit schema/);
  assert.deepEqual(calls,[]);
});
