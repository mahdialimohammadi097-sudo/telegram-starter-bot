import test from "node:test";
import assert from "node:assert/strict";
import {criticalTests,startupTests,verifyFinancialTestEvidence} from "../scripts/verify-financial-test-evidence.js";

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
  const fullNames=[...names,...startupTests];
  const tap=fullNames.map((name,i)=>"ok "+(i+1)+" - "+name).join("\n")+
    "\n# tests "+fullNames.length+"\n# pass "+fullNames.length+
    "\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  assert.deepEqual(verifyFinancialTestEvidence(tap,{full:true}),{tests:String(fullNames.length),critical:fullNames.length});
  assert.throws(()=>verifyFinancialTestEvidence(tap.replace(startupTests[0],"unrelated test"),{full:true}));
});

test("financial release evidence cannot omit any newly required database security regression",()=>{
 const required=["restricted role verifies runtime inventory without schema creation rights","restricted startup options apply to two independent PostgreSQL pool connections","restricted checkout rejects reused session drift before application queries","restricted pool discards unfinished and aborted transactions without committing","access audit detects column-level, PUBLIC and delegable ledger privileges","access audit distinguishes session role paths, callable privileged routines and ledger function ownership","PostgreSQL audit verifies effective settings and cannot write ordinary tables","ledger integrity detects blank and padded identities, unused non-USDT accounts and non-finite amounts","ledger catalog audit detects disabled or missing financial guards without mutating them","combined ledger release evidence rejects incomplete or non-table relations"];
 for(const name of required){
  assert.ok(criticalTests.includes(name));
  const line=success.split("\n").find(value=>value.endsWith(" - "+name));
  assert.ok(line);
  assert.throws(()=>verifyFinancialTestEvidence(success.replace(line,"ok 999 - unrelated fixture")),/Missing or ambiguous critical test evidence/);
  assert.throws(()=>verifyFinancialTestEvidence(success.replace(line,line+" # SKIP")),/Missing or ambiguous critical test evidence/);
 }
});
