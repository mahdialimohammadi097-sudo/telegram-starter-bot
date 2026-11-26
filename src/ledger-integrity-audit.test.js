import test from "node:test";
import assert from "node:assert/strict";
import { auditLedgerIntegrity } from "./ledger-integrity-audit.js";

function fakePool({ bad = false, fail = false, currency = "0", key = "0", shape = true, relationCount = 3, visibility = true, reserve = "0" } = {}) {
  const calls = [];
  const row = { journals:"2", posted_journals:"2", entries:"4", unresolved_journals:"0",
    missing_idempotency_keys:"0", duplicate_idempotency_keys:"0", invalid_entries:"0",
    invalid_account_currencies:currency, noncanonical_idempotency_keys:key,
    unbalanced_posted_journals:"0", negative_customer_accounts:bad?"1":"0", negative_noncustomer_protected_accounts:reserve };
  const client = { async query(sql) {
    calls.push(sql);
    if (sql.startsWith("BEGIN")) return { command:"BEGIN" };
    if (sql.startsWith("SET LOCAL")) return { command:"SET" };
    if (sql.startsWith("SELECT pg_catalog.current_setting")) return { rows:[{
      read_only:"on", isolation:"repeatable read", statement_timeout:"10s", lock_timeout:"3s" }] };
    if (sql.startsWith("SELECT current_setting")) return { rows:[{row_security:"off",search_path:"pg_catalog"}] };
    if (sql.includes("AS relation_shape_compatible")) return { rows:[{relation_count:relationCount,relation_shape_compatible:shape,row_visibility_compatible:visibility}] };
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
  assert.equal((await auditLedgerIntegrity(fakePool({currency:"1"}).pool)).clean,false);
  assert.equal((await auditLedgerIntegrity(fakePool({key:"1"}).pool)).clean,false);
  await assert.rejects(auditLedgerIntegrity(fakePool({currency:"-1"}).pool),/Incomplete ledger integrity audit/);
  const invalid=fakePool({fail:true});
  await assert.rejects(auditLedgerIntegrity(invalid.pool),/Incomplete ledger integrity audit/);
  assert.equal(invalid.calls.at(-2),"ROLLBACK");
});
test("audit rejects unsafe schema identifiers before connecting",async()=>{
  const {pool,calls}=fakePool();
  await assert.rejects(auditLedgerIntegrity(pool,{schema:'public"; DROP TABLE x;--'}),/Invalid ledger audit schema/);
  assert.deepEqual(calls,[]);
});

test("integrity audit rejects absent or incompatible relations before financial row inspection",async()=>{
  for(const options of [{shape:false},{shape:null},{relationCount:2}]){
    const {pool,calls}=fakePool(options);
    await assert.rejects(auditLedgerIntegrity(pool),/requires three permanent ordinary relations/);
    assert.equal(calls.some(sql=>sql.includes("WITH journals")),false);
    assert.equal(calls.at(-2),"ROLLBACK");
  }
});

test("integrity audit rejects unknown or unreviewed row visibility before reading financial rows",async()=>{
  for(const visibility of [false,null]){
    const {pool,calls}=fakePool({visibility});
    await assert.rejects(auditLedgerIntegrity(pool),/requires reviewed row visibility/);
    assert.equal(calls.some(sql=>sql.includes("WITH journals")),false);
    assert.equal(calls.at(-2),"ROLLBACK");
  }
});

test("integrity audit treats negative protected noncustomer balances as discrepancies",async()=>{
  const {pool,calls}=fakePool({reserve:"1"});
  const result=await auditLedgerIntegrity(pool);
  assert.equal(result.counts.negative_customer_accounts,"0");
  assert.equal(result.counts.negative_noncustomer_protected_accounts,"1");
  assert.equal(result.clean,false);
  assert.ok(calls.some(sql=>sql.includes("upper(a.account_type)")&&sql.includes("user_id IS NULL AND balance<0")));
  await assert.rejects(auditLedgerIntegrity(fakePool({reserve:null}).pool),/Incomplete ledger integrity audit/);
});
