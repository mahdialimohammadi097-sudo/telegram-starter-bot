import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
const script=new URL("./fadehost-schema-audit.js",import.meta.url);
test("missing database connection fails safely without disclosing credentials",()=>{
 const env={...process.env};
 delete env.DATABASE_URL;
 const result=spawnSync(process.execPath,[script.pathname],{env,encoding:"utf8",timeout:10000});
 assert.equal(result.status,3);
 assert.equal(result.stderr,"");
 assert.deepEqual(JSON.parse(result.stdout),{
  audit:"fadehost-schema",ready:false,error:"DATABASE_URL_NOT_CONFIGURED",
  financialActivationReady:false,realDepositsEnabled:false
 });
});
test("invalid private database endpoint emits sanitized failure only",()=>{
 const env={...process.env,DATABASE_URL:["postgresql://","secretuser:secretpass@127.0.0.1:1/private"].join("")};
 const result=spawnSync(process.execPath,[script.pathname],{env,encoding:"utf8",timeout:15000});
 assert.equal(result.status,3);
 assert.equal(result.stderr,"");
 assert.doesNotMatch(result.stdout,/secretuser|secretpass|127\.0\.0\.1/);
 const output=JSON.parse(result.stdout);
 assert.equal(output.ready,false);
 assert.equal(output.error,"READ_ONLY_AUDIT_FAILED");
 assert.equal(output.financialActivationReady,false);
 assert.equal(output.realDepositsEnabled,false);
});

test("conflicting TLS options fail closed and do not disclose the connection URL",()=>{
 const env={...process.env,DATABASE_URL:["postgresql://","fixture:synthetic@127.0.0.1:1/private?sslmode=disable"].join(""),
  PROFINO_DB_TLS_MODE:"verify-full"};
 delete env.PROFINO_DATABASE_TLS;
 const result=spawnSync(process.execPath,[script.pathname],{env,encoding:"utf8",timeout:15000});
 assert.equal(result.status,3);
 assert.equal(result.stderr,"");
 assert.doesNotMatch(result.stdout,/synthetic|127\.0\.0\.1|sslmode/);
 assert.equal(JSON.parse(result.stdout).error,"READ_ONLY_AUDIT_FAILED");
});

test("FadeHost schedule uses the full reviewed read-only catalog audit",()=>{
 const preload = `
  import {createRequire} from "node:module";
  const require=createRequire(process.cwd()+"/package.json");
  const pg=require("pg");
  pg.Pool.prototype.connect=async()=>({
   async query(sql){
    if(sql==="COMMIT")return {command:"COMMIT"};
    if(sql==="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")return {command:"BEGIN"};
    if(sql.startsWith("SET LOCAL"))return {command:"SET"};
    if(sql.includes("pg_catalog.current_setting('transaction_read_only')"))return {rows:[{read_only:"on",isolation:"repeatable read",statement_timeout:"10s",lock_timeout:"3s"}]};
    if(sql.includes("pg_catalog.current_setting('search_path')"))return {rows:[{search_path:"pg_catalog, pg_temp"}]};
    if(sql.includes("information_schema.columns"))return {rows:[]};
    if(sql.includes("FROM pg_index"))return {rows:[]};
    if(sql.includes("c.contype='f'"))return {rows:[]};
    if(sql.includes("c.contype='c'"))return {rows:[]};
    if(sql.includes("FROM pg_catalog.pg_trigger tg"))return {rows:[]};
    throw new Error("Unexpected query");
   },release(){}
  });
  pg.Pool.prototype.end=async function(){if(process.env.TEST_IDLE_FAILURE==="1")this.emit("error",new Error("synthetic-private-detail"));};
 `;
 const env={...process.env,DATABASE_URL:"postgresql://localhost/profino_test",PROFINO_DB_TLS_MODE:"disable"};
 delete env.PROFINO_DATABASE_TLS;
 const result=spawnSync(process.execPath,["--import","data:text/javascript,"+encodeURIComponent(preload),script.pathname],{env,encoding:"utf8",timeout:10000});
 assert.equal(result.status,2,result.stderr);
 const output=JSON.parse(result.stdout);
 assert.equal(output.ready,false);
 assert.equal(output.financialActivationReady,false);
 assert.equal(output.realDepositsEnabled,false);
 assert.ok(output.missing.includes("unique:ledger_transactions.idempotency_key"));
 assert.ok(output.incompatible.includes("ledger_entries.account_id:foreign_key"));
 assert.ok(output.incompatible.includes("verified_deposit_evidence.verified_deposit_evidence_event_key_format:check_constraint"));
 const failed=spawnSync(process.execPath,["--import","data:text/javascript,"+encodeURIComponent(preload),script.pathname],{env:{...env,TEST_IDLE_FAILURE:"1"},encoding:"utf8",timeout:10000});
 assert.equal(failed.status,3);
 assert.equal(failed.stderr,"");
 assert.doesNotMatch(failed.stdout,/synthetic-private-detail/);
 assert.deepEqual(JSON.parse(failed.stdout),{audit:"fadehost-schema",ready:false,error:"AUDIT_IDLE_CONNECTION_FAILED",financialActivationReady:false,realDepositsEnabled:false});
});
