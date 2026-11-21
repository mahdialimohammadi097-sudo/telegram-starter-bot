import test from "node:test";
import assert from "node:assert/strict";
import {auditDepositSchema} from "./deposit-schema-audit.js";
test("schema audit reports missing evidence table and required columns",async()=>{
 const client={query:async(sql)=>({rows:sql.includes('pg_indexes')?[]:[{table_name:"users",column_name:"id"}]})};
 const result=await auditDepositSchema(client);
 assert.equal(result.ready,false);
 assert.ok(result.missing.includes("verified_deposit_evidence.event_key"));
 assert.ok(result.missing.includes("users.status"));
});
test("schema audit rejects untrusted schema identifiers",async()=>{
 await assert.rejects(auditDepositSchema({query:async()=>({rows:[]})},{schema:"public; DROP TABLE users"}),/Invalid/);
});

test("schema audit fails closed without unique financial event indexes",async()=>{
 const client={query:async(sql)=>({rows:sql.includes("pg_indexes")?[]:[]})};
 const report=await auditDepositSchema(client);
 assert.equal(report.ready,false);
 assert.ok(report.incompatible.includes("verified_deposit_evidence.event_key:unique_index"));
 assert.ok(report.incompatible.includes("ledger_transactions.idempotency_key:unique_index"));
});
