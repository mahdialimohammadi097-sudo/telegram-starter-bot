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
  "data:ledger_entries.invalid_currency",
  "data:ledger_accounts.invalid_currency",
  "data:ledger_entries.account_currency_mismatch",
  "data:user_wallet_assignments.multiple_active_owners",
  "data:user_wallet_assignments.duplicate_active_wallet",
  "data:user_wallet_assignments.orphan_user",
  "data:user_wallet_assignments.orphan_wallet"
 ])assert.ok(source.includes(marker),marker);
 assert.match(source,/GROUP BY event_key HAVING COUNT\(\*\)>1/);
 assert.match(source,/GROUP BY idempotency_key HAVING COUNT\(\*\)>1/);
 assert.match(source,/BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
});

test("journal balance audit fails closed on NULLs and rejects missing sides",async()=>{
 const {readFileSync}=await import("node:fs");
 const source=readFileSync(script,"utf8");
 assert.ok(source.includes("amount IS NULL OR amount<=0 OR currency IS NULL"));
 assert.ok(source.includes("IS DISTINCT FROM SUM(CASE WHEN entry_type='credit'"));
 assert.ok(source.includes("COUNT(*) FILTER (WHERE entry_type='debit')=0"));
 assert.ok(source.includes("COUNT(*) FILTER (WHERE entry_type='credit')=0"));
});

test("audit includes posted journal leg integrity checks",async()=>{
 const {readFileSync}=await import("node:fs");
 const source=readFileSync(script,"utf8");
 assert.match(source,/data:ledger_transactions\.posted_insufficient_distinct_accounts/);
 assert.match(source,/data:ledger_transactions\.posted_invalid_entries/);
 assert.match(source,/COUNT\(DISTINCT e\.account_id\)<2/);
 assert.match(source,/t\.status='posted'/);
});

test("schema audit checks posted available-balance overdrafts",async()=>{
 const {readFileSync}=await import("node:fs");
 const source=readFileSync(script,"utf8");
 assert.match(source,/data:ledger_accounts\.negative_available_balance/);
 assert.match(source,/a\.account_type='AVAILABLE'/);
 assert.match(source,/t\.status='posted'/);
 assert.match(source,/WHEN e\.entry_type='debit' THEN -e\.amount/);
});

test("ledger foreign key audit requires exact target ID columns",async()=>{
 const {readFileSync}=await import("node:fs");
 const source=readFileSync(script,"utf8");
 assert.ok(source.includes("ta.attname AS target_column"));
 assert.ok(source.includes("ta.attnum=c.confkey[1]"));
 assert.ok(source.includes('references.has(column+":public."+target+".id")'));
 assert.ok(source.includes("c.convalidated"));
});
