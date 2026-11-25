import test from "node:test";
import assert from "node:assert/strict";
import {criticalTests,verifyFinancialTestEvidence} from "../scripts/verify-financial-test-evidence.js";

const success=criticalTests.map((name,i)=>"ok "+(i+1)+" - "+name).join("\n")+
  "\n# tests "+criticalTests.length+"\n# pass "+criticalTests.length+
  "\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";

test("financial CI evidence requires all critical positive assertions and clean totals",()=>{
  assert.deepEqual(verifyFinancialTestEvidence(success),{tests:String(criticalTests.length),critical:criticalTests.length});
  assert.deepEqual(verifyFinancialTestEvidence(success.replaceAll("\n","\r\n")),{tests:String(criticalTests.length),critical:criticalTests.length});
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
    success.replace("# pass "+criticalTests.length,"# pass 1"),
    success.replace("# pass "+criticalTests.length,""),
    success+"# tests 1\n",
    ""
  ]) assert.throws(()=>verifyFinancialTestEvidence(tap));
});
