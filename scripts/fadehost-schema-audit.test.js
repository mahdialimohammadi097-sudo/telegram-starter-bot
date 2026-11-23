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
 const env={...process.env,DATABASE_URL:"postgresql://secretuser:secretpass@127.0.0.1:1/private"};
 const result=spawnSync(process.execPath,[script.pathname],{env,encoding:"utf8",timeout:15000});
 assert.equal(result.status,3);
 assert.equal(result.stderr,"");
 assert.doesNotMatch(result.stdout,/secretuser|secretpass|127\.0\.0\.1/);
 const output=JSON.parse(result.stdout);
 assert.equal(output.ready,false);
 assert.equal(output.error,"READ_ONLY_AUDIT_FAILED");
});

test("schema audit cannot certify positivity from SQL text matching alone",async()=>{
 const {readFileSync}=await import("node:fs");
 const source=readFileSync(script,"utf8");
 assert.match(source,/manual_review:ledger_entries\.amount_positive_constraint/);
 assert.doesNotMatch(source,/hasPositiveAmountCheck/);
 assert.match(source,/BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
 assert.match(source,/default_transaction_read_only=on/);
});

test("read-only audit includes duplicate identity and ledger integrity checks",async()=>{
 const {readFileSync}=await import("node:fs");
 const source=readFileSync(script,"utf8");
 for(const marker of [
  "data:verified_deposit_evidence.duplicate_event_key",
  "data:ledger_transactions.duplicate_idempotency_key",
  "data:ledger_entries.orphan_transactions",
  "data:ledger_entries.orphan_accounts",
  "data:ledger_entries.nonpositive_amounts",
  "data:ledger_entries.unbalanced_journals",
  "data:ledger_entries.invalid_currency"
 ])assert.ok(source.includes(marker),marker);
 assert.match(source,/GROUP BY event_key HAVING COUNT\(\*\)>1/);
 assert.match(source,/GROUP BY idempotency_key HAVING COUNT\(\*\)>1/);
 assert.match(source,/BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
});
