import test from "node:test";
import assert from "node:assert/strict";
import { bep20BaseUnitsToLedgerAmount } from "./bep20-ledger-precision.js";
test("converts exact BEP20 USDT to eight decimal ledger amount",()=>{
 assert.equal(bep20BaseUnitsToLedgerAmount("1000000000000000000"),"1.00000000");
 assert.equal(bep20BaseUnitsToLedgerAmount("10000000000"),"0.00000001");
 assert.equal(bep20BaseUnitsToLedgerAmount("25000000000000000000"),"25.00000000");
});
test("rejects nonrepresentable fractional base units without rounding",()=>{
 assert.throws(()=>bep20BaseUnitsToLedgerAmount("1000000000000000001"),/manual review/);
 assert.throws(()=>bep20BaseUnitsToLedgerAmount("1"),/manual review/);
});
test("rejects invalid or zero amounts",()=>{
 for(const v of ["0","-1","1.5","01","1e18",1n,undefined]) assert.throws(()=>bep20BaseUnitsToLedgerAmount(v));
});
