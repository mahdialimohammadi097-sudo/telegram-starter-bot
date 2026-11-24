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
  audit:"fadehost-schema",ready:false,error:"DATABASE_URL_NOT_CONFIGURED"
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
