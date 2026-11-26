import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const path=fileURLToPath(new URL("./audit-restricted-runtime.js",import.meta.url));
const env={...process.env};
delete env.DATABASE_URL;
delete env.PROFINO_DATABASE_TLS;
delete env.PROFINO_DB_TLS_MODE;
delete env.PROFINO_DB_TLS_CA_PEM;
test("restricted runtime diagnostic reports missing configuration without starting Telegram",()=>{
 const result=spawnSync(process.execPath,[path],{env,encoding:"utf8",timeout:15000});
 assert.equal(result.status,3);
 assert.equal(result.stderr,"");
 assert.deepEqual(JSON.parse(result.stdout),{
  audit:"restricted-runtime",operationalInventoryVerified:false,financialActivationReady:false,reason:"DATABASE_URL_NOT_CONFIGURED"
 });
});
test("restricted runtime diagnostic never exposes invalid connection configuration",()=>{
 const result=spawnSync(process.execPath,[path],{env:{...env,DATABASE_URL:"invalid://fixture-user:fixture-password@localhost"},encoding:"utf8",timeout:15000});
 assert.equal(result.status,3);
 assert.equal(result.stderr,"");
 assert.doesNotMatch(result.stdout,/fixture-user|fixture-password|localhost/);
 assert.deepEqual(JSON.parse(result.stdout),{
  audit:"restricted-runtime",operationalInventoryVerified:false,financialActivationReady:false,reason:"AUDIT_FAILED"
 });
});

for(const [mode,reason] of [["idle","IDLE_CONNECTION_FAILED"],["cleanup","CLEANUP_FAILED"]]){
 test("restricted runtime diagnostic fails closed on "+mode+" during cleanup",()=>{
  const preload=`
    import {createRequire} from "node:module";
    const pg=createRequire(process.cwd()+"/package.json")("pg");
    pg.Pool.prototype.connect=async function(){throw new Error("synthetic-sensitive-connection");};
    pg.Pool.prototype.end=async function(){
      if(${JSON.stringify(mode)}==="idle")this.emit("error",new Error("synthetic-sensitive-idle"));
      else throw new Error("synthetic-sensitive-cleanup");
    };
  `;
  const result=spawnSync(process.execPath,["--import","data:text/javascript,"+encodeURIComponent(preload),path],{
    cwd:fileURLToPath(new URL("../",import.meta.url)),env:{...env,DATABASE_URL:"postgres://localhost/offline"},
    encoding:"utf8",timeout:15000
  });
  assert.equal(result.status,3,result.stderr);
  assert.equal(result.stderr,"");
  assert.deepEqual(JSON.parse(result.stdout),{
    audit:"restricted-runtime",operationalInventoryVerified:false,financialActivationReady:false,reason
  });
 });
}
