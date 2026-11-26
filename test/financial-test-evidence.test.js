import test from "node:test";
import assert from "node:assert/strict";
import {criticalTests,startupTests,fullAuditTests,verifyFinancialTestEvidence} from "../scripts/verify-financial-test-evidence.js";

const names=[...criticalTests,"staging preflight rejects permissive or unvalidated withdrawal state constraints"];
const success=names.map((name,i)=>"ok "+(i+1)+" - "+name).join("\n")+
  "\n# tests "+names.length+"\n# pass "+names.length+
  "\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";

test("financial CI evidence requires all critical positive assertions and clean totals",()=>{
  assert.deepEqual(verifyFinancialTestEvidence(success),{tests:String(names.length),critical:names.length});
  assert.deepEqual(verifyFinancialTestEvidence(success.replaceAll("\n","\r\n")),{tests:String(names.length),critical:names.length});
});
test("financial CI evidence rejects absent, duplicated, skipped or non-successful critical assertions",()=>{
  const first="ok 1 - "+criticalTests[0];
  for(const tap of [
    success.replace(first,"# diagnostic: "+criticalTests[0]),
    success.replace(first,first+" # SKIP"),
    success.replace(first,first+"\n"+first),
    success.replace(first,"not "+first),
    success.replace(first,"  "+first),
    success.replace("# fail 0","# fail 1"),
    success.replace("# skipped 0","# skipped 1"),
    success.replace("# cancelled 0","# cancelled 1"),
    success.replace("# todo 0","# todo 1"),
    success.replace("# pass "+names.length,"# pass 1"),
    success.replace("# pass "+names.length,""),
    success+"# tests 1\n",
    ""
  ]) assert.throws(()=>verifyFinancialTestEvidence(tap));
});

test("full release evidence also requires both offline startup isolation regressions",()=>{
  assert.throws(()=>verifyFinancialTestEvidence(success,{full:true}));
  const fullNames=[...names,...startupTests,...fullAuditTests];
  const tap=fullNames.map((name,i)=>"ok "+(i+1)+" - "+name).join("\n")+
    "\n# tests "+fullNames.length+"\n# pass "+fullNames.length+
    "\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  assert.deepEqual(verifyFinancialTestEvidence(tap,{full:true}),{tests:String(fullNames.length),critical:fullNames.length});
  assert.throws(()=>verifyFinancialTestEvidence(tap.replace(startupTests[0],"unrelated test"),{full:true}));
});

test("financial release evidence cannot omit any newly required database security regression",()=>{
 const required=["restricted role verifies runtime inventory without schema creation rights","restricted startup options apply to two independent PostgreSQL pool connections","restricted checkout rejects reused session drift before application queries","restricted pool discards unfinished and aborted transactions without committing","access audit detects column-level, PUBLIC and delegable ledger privileges","access audit distinguishes session role paths, callable privileged routines and ledger function ownership","PostgreSQL audit verifies effective settings and cannot write ordinary tables","ledger integrity detects blank and padded identities, unused non-USDT accounts and non-finite amounts","ledger catalog audit detects disabled or missing financial guards without mutating them","combined ledger release evidence rejects incomplete or non-table relations","wallet balance rejects duplicate account roles instead of combining them"];
 for(const name of required){
  assert.ok(criticalTests.includes(name));
  const line=success.split("\n").find(value=>value.endsWith(" - "+name));
  assert.ok(line);
  assert.throws(()=>verifyFinancialTestEvidence(success.replace(line,"ok 999 - unrelated fixture")),/Missing or ambiguous critical test evidence/);
  assert.throws(()=>verifyFinancialTestEvidence(success.replace(line,line+" # SKIP")),/Missing or ambiguous critical test evidence/);
 }
});

// Pin these names independently of the exported lists, so removing a required
// regression from the verifier itself cannot silently weaken the gate.
test("release evidence requires the latest ledger and catalog audit regressions",()=>{
 const requiredPostgres=["access catalog audit resists caller name-operator shadowing without changing session identity","access audit distinguishes unexpected named relations from permanent ordinary ledger tables","standalone ledger integrity refuses views, unlogged relations, inheritance and rewrite rules","standalone ledger integrity rejects enabled, forced and dormant row security policies even for an elevated audit role","ledger integrity detects negative platform reserve and mixed-case protected customer accounts","standalone ledger integrity detects ambiguous primary identities without relying on constraints"];
 const requiredFull=["database access diagnostic publishes one report after path-drift","database access diagnostic publishes one report after incompatible-shape","integrity audit rejects absent or incompatible relations before financial row inspection","integrity audit rejects unknown or unreviewed row visibility before reading financial rows","integrity audit treats negative protected noncustomer balances as discrepancies","integrity audit rejects duplicate or missing row identity evidence","manual ledger catalog export uses a bounded catalog-first read-only snapshot"];
 const fullNames=[...names,...startupTests,...fullAuditTests];
 const fullTap=fullNames.map((name,i)=>"ok "+(i+1)+" - "+name).join("\n")+
   "\n# tests "+fullNames.length+"\n# pass "+fullNames.length+"\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
 for(const [required,list,tap,options] of [[requiredPostgres,criticalTests,success,{}],[requiredFull,fullAuditTests,fullTap,{full:true}]]){
  for(const name of required){
   assert.ok(list.includes(name),name);
   const line=tap.split("\n").find(value=>value.endsWith(" - "+name));
   assert.ok(line,name);
   for(const altered of [line.replace(name,"unrelated fixture"),line+" # SKIP",line+"\n"+line]){
    assert.throws(()=>verifyFinancialTestEvidence(tap.replace(line,altered),options),/Missing or ambiguous critical test evidence/);
   }
  }
 }
});

test("full release gate requires the intermediate owner rehearsal reconciliation",()=>{
 const name="owner rehearsal requires exact intermediate reservation movement and rejects cancelled replay";
 assert.ok(fullAuditTests.includes(name));
 const fullNames=[...names,...startupTests,...fullAuditTests];
 const tap=fullNames.map((n,i)=>"ok "+(i+1)+" - "+n).join("\n")+
   "\n# tests "+fullNames.length+"\n# pass "+fullNames.length+
   "\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
 assert.throws(()=>verifyFinancialTestEvidence(tap.replace(name,"unrelated fixture"),{full:true}),/Missing or ambiguous critical test evidence/);
});
