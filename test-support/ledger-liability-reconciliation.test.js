import test from "node:test";
import assert from "node:assert/strict";
import { compareSyntheticCustody } from "./compare-synthetic-custody.js";
import { reconcileSimulatedLiabilities } from "./reconcile-simulated-liabilities.js";
const sample={available:"10.00000001",invested:"25",profit:"2",withdrawalHold:"5",otherObligations:"1",unencumberedAssetsBaseUnits:"43000000010000000000"};
test("exact custody comparison includes every supplied liability and one-base-unit shortfalls",()=>{
  const result=compareSyntheticCustody(sample);
  assert.equal(result.liabilitiesBaseUnits,"43000000010000000000");
  assert.equal(result.arithmeticCovered,true);
  assert.equal(result.custodyVerified,false);
  assert.equal(result.productionReady,false);
  const below=compareSyntheticCustody({...sample,unencumberedAssetsBaseUnits:"43000000009999999999"});
  assert.equal(below.shortfallBaseUnits,"1");
  assert.equal(below.arithmeticCovered,false);
  const above=compareSyntheticCustody({...sample,unencumberedAssetsBaseUnits:"43000000010000000001"});
  assert.equal(above.surplusBaseUnits,"1");
});
test("missing, rounded, negative and ambiguous custody values fail closed",()=>{
  for(const value of [undefined,null,1.1,"-1","1.000000001","1e3","NaN"," 1"]) {
    assert.throws(()=>compareSyntheticCustody({...sample,profit:value}),/Invalid exact liability/);
  }
  for(const value of [undefined,1,"-1","01","1.2",(1n<<256n).toString()]) {
    assert.throws(()=>compareSyntheticCustody({...sample,unencumberedAssetsBaseUnits:value}),/Invalid exact asset/);
  }
});
test("liability report rejects missing or nonexact count data",async()=>{
  await assert.rejects(reconcileSimulatedLiabilities({query:async()=>({rows:[]})}),/Incomplete/);
  await assert.rejects(reconcileSimulatedLiabilities({query:async()=>({rows:[{investment_mismatches:0}]})}),/Incomplete/);
});
