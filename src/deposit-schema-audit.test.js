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

test("schema audit refuses missing ownership and ledger foreign keys",async()=>{
 const client={query:async()=>({rows:[]})};
 const report=await auditDepositSchema(client);
 assert.equal(report.ready,false);
 assert.ok(report.incompatible.includes("user_wallet_assignments.user_id:foreign_key"));
 assert.ok(report.incompatible.includes("user_wallet_assignments.wallet_id:foreign_key"));
 assert.ok(report.incompatible.includes("ledger_entries.account_id:foreign_key"));
});

test("schema audit requires every column consumed by transactional owner resolver",async()=>{
 const client={query:async()=>({rows:[]})};
 const report=await auditDepositSchema(client);
 for(const column of [
  "wallets.wallet_type",
  "wallets.is_platform_controlled",
  "user_wallet_assignments.id",
  "user_wallet_assignments.ended_at"
 ]) assert.ok(report.missing.includes(column),column);
});

test("schema audit rejects evidence tables missing validated format checks",async()=>{
 const checks=[
  "verified_deposit_evidence_event_key_format",
  "verified_deposit_evidence_block_hash_format",
  "verified_deposit_evidence_token_format",
  "verified_deposit_evidence_address_format"
 ];
 const client={query:async(sql)=>{
  if(sql.includes("c.contype='c'")) return {rows:[
   {conname:checks[0],validated:true,expression:"(event_key ~ '^bsc:56:0x[0-9a-f]{64}:(0|[1-9][0-9]*)
  return {rows:[]};
 }};
 const report=await auditDepositSchema(client);
 assert.equal(report.ready,false);
 assert.ok(report.incompatible.includes("verified_deposit_evidence."+checks[3]+":check_constraint"));
 assert.ok(!report.incompatible.includes("verified_deposit_evidence."+checks[0]+":check_constraint"));
});
::text)"},
   {conname:checks[1],validated:true,expression:"(block_hash ~ '^0x[0-9a-f]{64}
  return {rows:[]};
 }};
 const report=await auditDepositSchema(client);
 assert.equal(report.ready,false);
 assert.ok(report.incompatible.includes("verified_deposit_evidence."+checks[3]+":check_constraint"));
 assert.ok(!report.incompatible.includes("verified_deposit_evidence."+checks[0]+":check_constraint"));
});
::text)"},
   {conname:checks[2],validated:true,expression:"(token_contract ~ '^0x[0-9a-f]{40}
  return {rows:[]};
 }};
 const report=await auditDepositSchema(client);
 assert.equal(report.ready,false);
 assert.ok(report.incompatible.includes("verified_deposit_evidence."+checks[3]+":check_constraint"));
 assert.ok(!report.incompatible.includes("verified_deposit_evidence."+checks[0]+":check_constraint"));
});
::text)"},
   {conname:checks[3],validated:false,expression:"(deposit_address ~ '^0x[0-9a-f]{40}
  return {rows:[]};
 }};
 const report=await auditDepositSchema(client);
 assert.equal(report.ready,false);
 assert.ok(report.incompatible.includes("verified_deposit_evidence."+checks[3]+":check_constraint"));
 assert.ok(!report.incompatible.includes("verified_deposit_evidence."+checks[0]+":check_constraint"));
});
::text)"}
  ]};
  return {rows:[]};
 }};
 const report=await auditDepositSchema(client);
 assert.equal(report.ready,false);
 assert.ok(report.incompatible.includes("verified_deposit_evidence."+checks[3]+":check_constraint"));
 assert.ok(!report.incompatible.includes("verified_deposit_evidence."+checks[0]+":check_constraint"));
});

test("schema audit refuses named but ineffective checks and nullable idempotency keys",async()=>{
 const client={query:async(sql)=>({rows:sql.includes("c.contype='c'")?
  [{conname:"verified_deposit_evidence_event_key_format",validated:true,expression:"true"}]:
  sql.includes("information_schema.columns")?
  [{table_name:"ledger_transactions",column_name:"idempotency_key",data_type:"text",is_nullable:"YES"}]:[]})};
 const report=await auditDepositSchema(client);
 assert.equal(report.ready,false);
 assert.ok(report.incompatible.includes("verified_deposit_evidence.verified_deposit_evidence_event_key_format:check_constraint"));
 assert.ok(report.incompatible.includes("ledger_transactions.idempotency_key:not_null"));
});
