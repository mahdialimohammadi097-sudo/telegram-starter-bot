import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./audit-deposit-schema.js", import.meta.url));
function run(args, env = {}) {
  // No inherited database connection or credentials; reject inputs before connecting.
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 10000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 3);
  assert.equal(result.stdout, "");
  const report=JSON.parse(result.stderr);
  assert.equal(report.financialActivationReady,false);
  assert.equal(report.realDepositsEnabled,false);
  return report;
}

test("default deposit audit retains its failure report when no DSN is supplied", () => {
  const report = run([]);
  assert.equal(report.audit, "deposit-schema");
  assert.equal(report.ready, false);
});

test("combined audit fails closed when connection configuration is missing", () => {
  const report = run(["--include-legacy-assignments"]);
  assert.equal(report.audit, "combined-deposit-preflight");
  assert.equal(report.ready, false);
  assert.equal(report.realDepositsEnabled, false);
});

test("unsupported arguments are refused without exposing input", () => {
  const marker = "synthetic-sensitive-argument";
  const report = run(["--include-legacy-assignments", marker]);
  assert.equal(report.ready, false);
  assert.ok(!JSON.stringify(report).includes(marker));
});

test("combined audit refuses ambiguous TLS configuration without printing DSN", () => {
  const marker = "synthetic-invalid-url";
  const report = run(["--include-legacy-assignments"], { DATABASE_URL: marker });
  assert.equal(report.ready, false);
  assert.equal(report.realDepositsEnabled, false);
  assert.ok(!JSON.stringify(report).includes(marker));
});

// Process-boundary regression: use an in-memory pg mock, no database sockets.
test("default deposit CLI requires confirmed catalog search path before reading metadata",()=>{
 const preload=`
 import {createRequire} from "node:module";
 const require=createRequire(process.cwd()+"/package.json");
 const pg=require("pg");
 pg.Pool.prototype.connect=async()=>{
  let confirmed=false;
  return {async query(sql){
   if(sql.startsWith("BEGIN"))return {command:"BEGIN"};
   if(sql.startsWith("SET LOCAL"))return {command:"SET"};
   if(sql.includes("current_setting('transaction_read_only')"))return {rows:[{read_only:"on",isolation:"repeatable read",statement_timeout:"10s",lock_timeout:"3s"}]};
   if(sql.includes("current_setting('search_path')")){
    confirmed=process.env.TEST_DRIFT!=="1";
    return {rows:[{search_path:confirmed?"pg_catalog, pg_temp":"public, pg_catalog"}]};
   }
   if(sql==="COMMIT"||sql==="ROLLBACK")return {command:sql};
   if(!confirmed)throw new Error("unexpected metadata query");
   return {rows:[]};
  },release(){}};
 };
 pg.Pool.prototype.end=async()=>{};
 `;
 const env={PATH:process.env.PATH,DATABASE_URL:"postgresql://localhost/profino_test",PROFINO_DB_TLS_MODE:"disable"};
 const args=["--import","data:text/javascript,"+encodeURIComponent(preload),script];
 const clean=spawnSync(process.execPath,args,{env,encoding:"utf8",timeout:10000});
 assert.equal(clean.status,2,clean.stderr);
 const report=JSON.parse(clean.stdout);
 assert.ok(report.missing.includes("verified_deposit_evidence.event_key"));
 assert.equal(report.realDepositsEnabled,false);
 const drifted=spawnSync(process.execPath,args,{env:{...env,TEST_DRIFT:"1"},encoding:"utf8",timeout:10000});
 assert.equal(drifted.status,3);
 assert.equal(drifted.stdout,"");
 assert.equal(JSON.parse(drifted.stderr).financialActivationReady,false);
});
