import test from "node:test";
import assert from "node:assert/strict";
import { requireUniqueDepositOwner } from "./deposit-owner-guard.js";
const address="0x"+"a".repeat(40);
const evidence={depositAddress:address,eventKey:"bsc:56:0x"+"b".repeat(64)+":0",ledgerAmount:"10.00000000"};
const owner={userId:"42",address,active:true,chainId:56,currency:"USDT"};
test("accepts only a unique active owner on the correct chain",()=>{
 const result=requireUniqueDepositOwner(evidence,[owner]);
 assert.equal(result.userId,"42");
 assert.equal(result.ledgerAmount,"10.00000000");
});
test("fails closed for missing, duplicate or ambiguous owners",()=>{
 for(const owners of [[],[owner,owner],[owner,{...owner,userId:"43"}]]) {
  assert.throws(()=>requireUniqueDepositOwner(evidence,owners),/exactly one/);
 }
});
test("rejects inactive, mismatched or invalid assignments",()=>{
 for(const candidate of [{...owner,active:false},{...owner,chainId:97},{...owner,currency:"BNB"},{...owner,userId:"0"},{...owner,address:"0x"+"c".repeat(40)}]) {
  assert.throws(()=>requireUniqueDepositOwner(evidence,[candidate]));
 }
});
test("rejects malformed or missing verified evidence",()=>{
 assert.throws(()=>requireUniqueDepositOwner({...evidence,eventKey:"invalid"},[owner]));
 assert.throws(()=>requireUniqueDepositOwner({...evidence,ledgerAmount:"10.1"},[owner]));
});
