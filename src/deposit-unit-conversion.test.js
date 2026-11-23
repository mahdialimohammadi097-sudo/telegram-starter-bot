import test from "node:test";
import assert from "node:assert/strict";
import {convertDepositBaseUnitsToLedgerUnits as convert} from "./deposit-unit-conversion.js";
test("converts 18-decimal token amounts to 8-decimal ledger units without rounding",()=>{
 assert.equal(convert("1250000000000000000",18),"125000000");
 assert.throws(()=>convert("1250000000000000001",18),/exactly/);
});
test("converts 6 and 8 decimal token units exactly",()=>{
 assert.equal(convert("1250000",6),"125000000");
 assert.equal(convert("125000000",8),"125000000");
});
test("rejects zero, signs, fractions, scientific notation, and invalid decimals",()=>{
 for(const value of ["0","-1","+1","1.5","1e8"," 1","01",1,null])
  assert.throws(()=>convert(value,18));
 for(const decimals of [-1,37,1.5,"18",null])
  assert.throws(()=>convert("1",decimals));
});
test("supports large integer amounts without floating point loss",()=>{
 assert.equal(convert("12345678901234567890123456",8),"12345678901234567890123456");
 assert.throws(()=>convert("123456789012345678901234567",8),/capacity/);
 assert.throws(()=>convert("9".repeat(79),18),/Invalid/);
 assert.throws(()=>convert("9".repeat(78),8),/capacity/);
});
