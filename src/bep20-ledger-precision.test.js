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

test("rejects amounts outside uint256 before ledger conversion",()=>{
 const max=(1n<<256n)-1n;
 const scale=10000000000n;
 assert.throws(()=>bep20BaseUnitsToLedgerAmount((max-max%scale).toString()),/ledger numeric capacity/);
 assert.throws(()=>bep20BaseUnitsToLedgerAmount(((max/scale+1n)*scale).toString()),/uint256/);
 assert.throws(()=>bep20BaseUnitsToLedgerAmount("9".repeat(10000)),/Invalid base units/);
});

test("rejects deposits beyond reviewed PostgreSQL numeric capacity before posting",()=>{
 const maxUnits=10n**26n-1n, scale=10n**10n;
 assert.equal(bep20BaseUnitsToLedgerAmount((maxUnits*scale).toString()),"999999999999999999.99999999");
 assert.throws(()=>bep20BaseUnitsToLedgerAmount(((maxUnits+1n)*scale).toString()),/ledger numeric capacity/);
 assert.throws(()=>bep20BaseUnitsToLedgerAmount(((maxUnits+2n)*scale).toString()),/ledger numeric capacity/);
});
