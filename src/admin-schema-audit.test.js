import test from "node:test";
import assert from "node:assert/strict";
import {inspectDepositSchemaReadOnly,deliverAdminSchemaAudit} from "./admin-schema-audit.js";

const validSettings={read_only:"on",isolation:"repeatable read",statement_timeout:"5s",lock_timeout:"3s"};
function withConfirmedControl(client){
 return {...client,async query(sql,...args){
  const result=await client.query(sql,...args);
  if(sql.startsWith("BEGIN "))return {command:"BEGIN"};
  if(sql.startsWith("SET LOCAL "))return {command:"SET"};
  if(sql.includes("pg_catalog.current_setting('transaction_read_only')"))return {rows:[validSettings]};
  if(sql==="ROLLBACK")return {command:"ROLLBACK"};
  return result;
 }};
}

test("read-only schema audit reports missing evidence without accessing user rows",async()=>{
 const statements=[];
 const client={query:async(sql)=>{
  statements.push(sql);
  if(sql.includes("information_schema.columns"))return {rows:[
   {table_name:"wallets",column_name:"id"}]};
  if(sql.includes("FROM pg_index"))return {rows:[]};
  return {rows:[]};
 },release:()=>{}};
 const result=await inspectDepositSchemaReadOnly({connect:async()=>withConfirmedControl(client)});
 assert.equal(result.structuralReady,false);
 assert.equal(result.historicalBasicGuardsPresent,false);
 assert.equal(result.financialActivationReady,false);
 assert.equal(result.realDepositsEnabled,false);
 assert.ok(result.outstandingSecurityGates.includes("independent-historical-ownership-proof"));
 assert.ok(result.missing.includes("verified_deposit_evidence.event_key"));
 assert.ok(result.missing.includes("unique:verified_deposit_evidence.event_key"));
 assert.equal(statements[0],"BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
 assert.equal(statements.at(-1),"ROLLBACK");
 assert.ok(!statements.some(sql=>/SELECT\s+\*|FROM\s+users\b/i.test(sql)));
});
test("read-only schema audit rolls back when catalog inspection fails",async()=>{
 let rolledBack=false,released=false;
 const client={query:async(sql)=>{
  if(sql==="ROLLBACK"){rolledBack=true;return {rows:[]};}
  if(sql.includes("information_schema"))throw Error("catalog unavailable");
  return {rows:[]};
 },release:()=>{released=true;}};
 await assert.rejects(inspectDepositSchemaReadOnly({connect:async()=>withConfirmedControl(client)}),/catalog unavailable/);
 assert.equal(rolledBack,true);
 assert.equal(released,true);
});

test("legacy column and index inventory alone cannot certify structural readiness",async()=>{
 const required={
  users:["id"],
  verified_deposit_evidence:["event_key","block_hash","block_number","token_contract","deposit_address","amount_base_units"],
  wallets:["id","wallet_address","chain_id","is_platform_controlled"],
  ledger_accounts:["id","user_id","account_type","currency"],
  ledger_transactions:["id","idempotency_key","status","transaction_type","reference_id"],
  ledger_entries:["transaction_id","account_id","entry_type","amount","currency"],
  user_wallet_assignments:["id","user_id","wallet_id","assignment_type","status","ended_at"],
  deposit_address_ownership_history:["id","wallet_id","user_id","chain_id","wallet_address","start_block","end_block","recorded_at","verified_source"]
 };
 const columns=Object.entries(required).flatMap(([table_name,names])=>
  names.map(column_name=>({table_name,column_name})));
 const client={query:async(sql)=>{
  if(sql.includes("information_schema.columns"))return {rows:columns};
  if(sql.includes("FROM pg_index"))return {rows:[{table_name:"verified_deposit_evidence",column_name:"event_key"},{table_name:"ledger_transactions",column_name:"idempotency_key"}]};
  return {rows:[]};
 },release:()=>{}};
 const result=await inspectDepositSchemaReadOnly({connect:async()=>withConfirmedControl(client)});
 assert.equal(result.structuralReady,false);
 assert.ok(result.missing.includes("users.status"));
 assert.ok(result.catalogIncompatible.includes("ledger_entries.account_id:foreign_key"));
 assert.equal(result.outstandingSecurityGates.length,5);
 assert.equal(result.historicalBasicGuardsPresent,false);
 assert.ok(result.outstandingSecurityGates.includes('historical-schema-definition-and-effective-privilege-review'));
 assert.equal(result.financialActivationReady,false);
 assert.equal(result.realDepositsEnabled,false);
});
test("schema audit rejects nonunique event index despite all columns existing",async()=>{
 const required={
  users:["id"],
  verified_deposit_evidence:["event_key","block_hash","block_number","token_contract","deposit_address","amount_base_units"],
  wallets:["id","wallet_address","chain_id","is_platform_controlled"],
  ledger_accounts:["id","user_id","account_type","currency"],
  ledger_transactions:["id","idempotency_key","status","transaction_type","reference_id"],
  ledger_entries:["transaction_id","account_id","entry_type","amount","currency"],
  user_wallet_assignments:["id","user_id","wallet_id","assignment_type","status","ended_at"],
  deposit_address_ownership_history:["id","wallet_id","user_id","chain_id","wallet_address","start_block","end_block","recorded_at","verified_source"]
 };
 const columns=Object.entries(required).flatMap(([table_name,names])=>
  names.map(column_name=>({table_name,column_name})));
 const client={query:async(sql)=>{
  if(sql.includes("information_schema.columns"))return {rows:columns};
  if(sql.includes("FROM pg_index"))return {rows:[{table_name:"ledger_transactions",column_name:"idempotency_key"}]};
  return {rows:[]};
 },release:()=>{}};
 const result=await inspectDepositSchemaReadOnly({connect:async()=>withConfirmedControl(client)});
 assert.equal(result.structuralReady,false);
 assert.ok(result.missing.includes("unique:verified_deposit_evidence.event_key"));
});

test("admin audit never leaks database exception messages or blocks bot startup",async()=>{
 const messages=[],codes=[];
 const pool={connect:async()=>{const error=new Error("SECRET_DATABASE_URL password=secret");
  error.code="28P01";throw error;}};
 const result=await deliverAdminSchemaAudit({pool,adminId:123,
  sendMessage:async(id,message)=>messages.push({id,message}),
  logCode:code=>codes.push(code)});
 assert.equal(result,false);
 assert.deepEqual(messages,[]);
 assert.deepEqual(codes,["28P01"]);
});
test("admin audit ignores Telegram send failure and logs only sanitized code",async()=>{
 const codes=[];
 const pool={connect:async()=>withConfirmedControl({query:async(sql)=>{
  if(sql.includes("information_schema"))return {rows:[]};
  return {rows:[]};
 },release:()=>{}})};
 const result=await deliverAdminSchemaAudit({pool,adminId:123,
  sendMessage:async()=>{throw Error("SECRET_TOKEN leaked");},
  logCode:code=>codes.push(code)});
 assert.equal(result,false);
 assert.deepEqual(codes,["UNKNOWN"]);
});

test("successful audit sends metadata only to configured admin ID",async()=>{
 const sent=[];
 const pool={connect:async()=>withConfirmedControl({query:async(sql)=>{
  if(sql.includes("information_schema.columns"))return {rows:[]};
  if(sql.includes("FROM pg_index"))return {rows:[]};
  return {rows:[]};
 },release:()=>{}})};
 const result=await deliverAdminSchemaAudit({pool,adminId:8810232463,
  sendMessage:async(id,message)=>sent.push({id,message})});
 assert.equal(result,true);
 assert.equal(sent.length,1);
 assert.equal(sent[0].id,8810232463);
 assert.match(sent[0].message,/financialActivationReady/);
 assert.doesNotMatch(sent[0].message,/DATABASE_URL|password=|SECRET_TOKEN/);
});

test("migration type preflight rejects incompatible existing wallet IDs without reading user rows",async()=>{
 const queries=[];
 const client={query:async(sql)=>{
  queries.push(sql);
  if(sql.includes("information_schema.columns"))return {rows:[
   {table_name:"users",column_name:"id",data_type:"bigint"},
   {table_name:"wallets",column_name:"id",data_type:"integer"},
   {table_name:"wallets",column_name:"chain_id",data_type:"integer"},
   {table_name:"user_wallet_assignments",column_name:"user_id",data_type:"bigint"},
   {table_name:"user_wallet_assignments",column_name:"wallet_id",data_type:"bigint"}
  ]};
  return {rows:[]};
 },release:()=>{}};
 const result=await inspectDepositSchemaReadOnly({connect:async()=>withConfirmedControl(client)});
 assert.equal(result.migrationTypeCompatible,false);
 assert.deepEqual(result.incompatibleTypes,[{
  column:"wallets.id",expected:"bigint",observed:"integer"
 }]);
 assert.equal(result.financialActivationReady,false);
 assert.ok(queries.every(sql=>!/FROM\\s+users\\b|FROM\\s+wallets\\b|SELECT\\s+\\*/i.test(sql)));
});

test("read-only type audit includes users table in catalog scope",async()=>{
 const statements=[];
 const client={query:async(sql,params)=>{
  statements.push({sql,params});
  if(sql.includes("information_schema.columns"))return {rows:[
   {table_name:"users",column_name:"id",data_type:"bigint"},
   {table_name:"wallets",column_name:"id",data_type:"bigint"},
   {table_name:"wallets",column_name:"chain_id",data_type:"integer"},
   {table_name:"user_wallet_assignments",column_name:"user_id",data_type:"bigint"},
   {table_name:"user_wallet_assignments",column_name:"wallet_id",data_type:"bigint"}
  ]};
  return {rows:[]};
 },release:()=>{}};
 const report=await inspectDepositSchemaReadOnly({connect:async()=>withConfirmedControl(client)});
 assert.ok(statements.find(x=>x.sql.includes("information_schema.columns")).params[0].includes("users"));
 assert.ok(!report.incompatibleTypes.some(x=>x.column==="users.id"));
 assert.ok(!report.incompatibleTypes.some(x=>x.column==="wallets.chain_id"));
 assert.equal(report.financialActivationReady,false);
});

test("read-only audit accepts bigint chain IDs under reviewed migration contract",async()=>{
 const client={query:async(sql)=>{
  if(sql.includes("information_schema.columns"))return {rows:[
   {table_name:"users",column_name:"id",data_type:"bigint"},
   {table_name:"wallets",column_name:"id",data_type:"bigint"},
   {table_name:"wallets",column_name:"chain_id",data_type:"bigint"},
   {table_name:"user_wallet_assignments",column_name:"user_id",data_type:"bigint"},
   {table_name:"user_wallet_assignments",column_name:"wallet_id",data_type:"bigint"}
  ]};
  return {rows:[]};
 },release:()=>{}};
 const result=await inspectDepositSchemaReadOnly({connect:async()=>withConfirmedControl(client)});
 assert.ok(!result.incompatibleTypes.some(x=>x.column==="wallets.chain_id"));
 assert.equal(result.migrationTypeCompatible,true);
 assert.equal(result.financialActivationReady,false);
 assert.equal(result.realDepositsEnabled,false);
});

test("schema audit discards a client after rollback failure and preserves original error",async()=>{
 const original=new Error("catalog unavailable");
 let releases=0,releaseError;
 const client={query:async(sql)=>{
  if(sql.includes("information_schema.columns"))throw original;
  if(sql==="ROLLBACK")throw new Error("synthetic rollback failure");
  return {rows:[]};
 },release:(error)=>{releases++;releaseError=error;}};
 await assert.rejects(inspectDepositSchemaReadOnly({connect:async()=>withConfirmedControl(client)}),
  error=>error===original);
 assert.equal(releases,1);
 assert.equal(releaseError?.message,"schema_audit_rollback_failed");
});

test("successful schema audit releases a reusable client",async()=>{
 let releases=0,releaseError;
 const client={query:async()=>({rows:[]}),
  release:(error)=>{releases++;releaseError=error;}};
 await inspectDepositSchemaReadOnly({connect:async()=>withConfirmedControl(client)});
 assert.equal(releases,1);
 assert.equal(releaseError,undefined);
});

test("catalog report requires immediate unique indexes and bounds lock waits",async()=>{
 const statements=[];
 const client={query:async(sql)=>{statements.push(sql);return {rows:[]};},release:()=>{}};
 await inspectDepositSchemaReadOnly({connect:async()=>withConfirmedControl(client)});
 assert.ok(statements.includes("SET LOCAL lock_timeout = '3000ms'"));
 assert.match(statements.find(sql=>sql.includes("FROM pg_index")),/i\.indimmediate/);
});

test("failure in the optional diagnostic logger does not interrupt startup",async()=>{
 const result=await deliverAdminSchemaAudit({
  pool:{connect:async()=>{throw new Error("synthetic unavailable");}},
  adminId:123,sendMessage:async()=>{throw new Error("unexpected send");},
  logCode:()=>{throw new Error("synthetic logger failure");}
 });
 assert.equal(result,false);
});

test("startup report rejects ineffective evidence constraints even when legacy keys exist",async()=>{
 const client={query:async(sql)=>{
  if(sql.includes("c.contype='c'"))return {rows:[{conname:"verified_deposit_evidence_event_key_format",validated:true,expression:"true"}]};
  if(sql.includes("information_schema.columns"))return {rows:[{table_name:"ledger_transactions",column_name:"idempotency_key",data_type:"text",is_nullable:"YES"}]};
  if(sql.includes("FROM pg_index"))return {rows:[{table_name:"verified_deposit_evidence",column_name:"event_key"},{table_name:"ledger_transactions",column_name:"idempotency_key"}]};
  return {rows:[]};
 },release:()=>{}};
 const result=await inspectDepositSchemaReadOnly({connect:async()=>withConfirmedControl(client)});
 assert.equal(result.structuralReady,false);
 assert.ok(result.catalogIncompatible.includes("verified_deposit_evidence.verified_deposit_evidence_event_key_format:check_constraint"));
 assert.ok(result.catalogIncompatible.includes("ledger_transactions.idempotency_key:not_null"));
 assert.equal(result.financialActivationReady,false);
 assert.equal(result.realDepositsEnabled,false);
});

for(const scenario of ["begin","set","read-only","isolation","statement-timeout","lock-timeout","completion","failure-rollback"]){
 test("startup audit rejects uncertain session: "+scenario,async()=>{
  const queries=[],releases=[];
  const original=new Error("fixture catalog failure");
  const client={async query(sql){
   queries.push(sql);
   if(sql.startsWith("BEGIN "))return {command:scenario==="begin"?undefined:"BEGIN"};
   if(sql.startsWith("SET LOCAL "))return {command:scenario==="set"?undefined:"SET"};
   if(sql.includes("pg_catalog.current_setting('transaction_read_only')")){
    const settings={...validSettings};
    if(scenario==="read-only")settings.read_only="off";
    if(scenario==="isolation")settings.isolation="read committed";
    if(scenario==="statement-timeout")settings.statement_timeout="0";
    if(scenario==="lock-timeout")settings.lock_timeout="0";
    return {rows:[settings]};
   }
   if(sql==="ROLLBACK")return {command:["completion","failure-rollback"].includes(scenario)?undefined:"ROLLBACK"};
   if(scenario==="failure-rollback")throw original;
   return {rows:[]};
  },release(error){releases.push(error);}};
  await assert.rejects(inspectDepositSchemaReadOnly({connect:async()=>client}),error=>scenario==="failure-rollback"?error===original:/unconfirmed|incompatible/.test(error.message));
  assert.equal(releases.length,1);
  assert.equal(Boolean(releases[0]),["begin","completion","failure-rollback"].includes(scenario));
  assert.equal(queries.filter(sql=>sql==="ROLLBACK").length,scenario==="begin"?0:1);
  if(!["completion","failure-rollback"].includes(scenario))assert.ok(!queries.some(sql=>sql.includes("information_schema.columns")));
 });
}

test("read-only audit rejects noninteger chain ID types",async()=>{
 for(const data_type of ["text","numeric","smallint",undefined]){
  const client={query:async(sql)=>{
   if(sql.includes("information_schema.columns"))return {rows:[
    {table_name:"users",column_name:"id",data_type:"bigint"},
    {table_name:"wallets",column_name:"id",data_type:"bigint"},
    ...(data_type===undefined?[]:[{table_name:"wallets",column_name:"chain_id",data_type}]),
    {table_name:"user_wallet_assignments",column_name:"user_id",data_type:"bigint"},
    {table_name:"user_wallet_assignments",column_name:"wallet_id",data_type:"bigint"}
   ]};
   return {rows:[]};
  },release:()=>{}};
  const report=await inspectDepositSchemaReadOnly({connect:async()=>withConfirmedControl(client)});
  assert.equal(report.migrationTypeCompatible,false);
  assert.ok(report.incompatibleTypes.some(x=>x.column==="wallets.chain_id"&&x.expected==="integer or bigint"));
  assert.equal(report.financialActivationReady,false);
 }
});
