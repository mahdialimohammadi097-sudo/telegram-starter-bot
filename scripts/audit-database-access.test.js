import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const script=fileURLToPath(new URL("./audit-database-access.js",import.meta.url));
const root=fileURLToPath(new URL("../",import.meta.url));
const scope={audit:"database-access",scope:"current-connection-only",financialActivationReady:false,productionReady:false};
const env={...process.env};
for(const k of ["DATABASE_URL","PROFINO_DATABASE_TLS","PROFINO_DB_TLS_MODE","PROFINO_DB_TLS_CA_PEM"])delete env[k];
test("database access diagnostic sanitizes missing or invalid configuration",()=>{
  for(const extra of [{},{DATABASE_URL:"invalid://fixture-user:fixture-secret@localhost"}]){
    const result=spawnSync(process.execPath,[script],{env:{...env,...extra},encoding:"utf8",timeout:15000});
    assert.equal(result.status,3);
    assert.equal(result.stdout,"");
    assert.deepEqual(JSON.parse(result.stderr),{...scope,error:"AUDIT_FAILED"});
  }
});
for(const mode of ["success","cleanup","idle","path-drift"]){
  test("database access diagnostic publishes one report after "+mode,()=>{
    // Patch only the external pg boundary; execute the real audit and CLI.
    // No socket or database is contacted.
    const preload=`
      import { createRequire } from "node:module";
      const pg=createRequire(process.cwd()+"/package.json")("pg");
      const mode=${JSON.stringify(mode)};
      pg.Pool.prototype.connect=async function(){
        return {async query(sql){
          if(sql.includes("AS read_only")&&sql.includes("AS isolation"))return {rows:[{read_only:"on",isolation:"repeatable read",statement_timeout:"10s",lock_timeout:"3s"}]};
          if(sql.includes("current_setting('search_path')"))return {rows:[{search_path:mode==="path-drift"?"public, pg_catalog":"pg_catalog, pg_temp"}]};
          if(sql.includes("AS ledger_tables_present")){
            const row={read_only:true,tls:false,privileged_role_membership:false,public_schema_create:false,session_role_matches:true,can_set_replication_role:false,replication_role_origin:true,session_can_assume_other_role:false,schema_callable_security_definer:false,session_can_assume_ledger_function_owner:false,ledger_functions_public_execute:false,server_major:17};
            for(const key of ["ledger_tables_present","ledger_tables_owned","ledger_tables_truncatable","ledger_tables_trigger_privilege","ledger_tables_insertable","ledger_tables_updatable","ledger_tables_deletable","ledger_tables_rls_enabled","ledger_tables_delegable","ledger_tables_public_write","ledger_tables_session_owner_access","ledger_tables_rls_forced","ledger_tables_rls_active","ledger_tables_with_policies","ledger_tables_public_write_policy"])row[key]=key==="ledger_tables_present"?3:0;
            return {rows:[row]};
          }
          return {command:sql.split(" ")[0]};
        },release(){}};
      };
      pg.Pool.prototype.end=async function(){
        if(mode==="idle")this.emit("error",new Error("synthetic-sensitive-idle"));
        if(mode==="cleanup")throw new Error("synthetic-sensitive-cleanup");
      };
    `;
    const result=spawnSync(process.execPath,["--import","data:text/javascript,"+encodeURIComponent(preload),script],{cwd:root,env:{...env,DATABASE_URL:"postgres://localhost/offline"},encoding:"utf8",timeout:15000});
    if(mode==="success"){
      assert.equal(result.status,0,result.stderr);
      assert.equal(result.stderr,"");
      const report=JSON.parse(result.stdout);
      assert.deepEqual({...report,evidence:undefined},{...scope,evidence:undefined});
      assert.equal(report.evidence.ledger_tables_present,3);
    }else{
      assert.equal(result.status,3);
      assert.equal(result.stdout,"");
      assert.deepEqual(JSON.parse(result.stderr),{...scope,error:mode==="idle"?"AUDIT_IDLE_CONNECTION_FAILED":mode==="cleanup"?"AUDIT_CLEANUP_FAILED":"AUDIT_FAILED"});
    }
  });
}
