import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const script=fileURLToPath(new URL("./audit-ledger-release.js",import.meta.url));
const env={...process.env};
for(const key of ["DATABASE_URL","PROFINO_DATABASE_TLS","PROFINO_DB_TLS_MODE","PROFINO_DB_TLS_CA_PEM"])delete env[key];

for(const [name,configuration,reason] of [
  ["missing configuration",{},"DATABASE_URL_NOT_CONFIGURED"],
  ["invalid connection configuration",{DATABASE_URL:"invalid://fixture-user:fixture-password@localhost"},"AUDIT_FAILED"]
]){
  test("ledger release diagnostic fails closed on "+name,()=>{
    const result=spawnSync(process.execPath,[script],{env:{...env,...configuration},encoding:"utf8",timeout:15000});
    assert.equal(result.status,3);
    assert.equal(result.stderr,"");
    assert.doesNotMatch(result.stdout,/fixture-user|fixture-password|localhost/);
    assert.deepEqual(JSON.parse(result.stdout),{
      audit:"ledger-release-evidence",checksPassed:false,reason,
      custodyVerified:false,financialActivationReady:false,productionReady:false
    });
  });
}
