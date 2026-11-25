import test from "node:test";
import assert from "node:assert/strict";
import { requireUniqueDepositOwner } from "./deposit-owner-guard.js";
const address="0x"+"a".repeat(40);
const evidence={chainId:"56",tokenContract:"0x"+"c".repeat(40),depositAddress:address,eventKey:"bsc:56:0x"+"b".repeat(64)+":0",ledgerAmount:"10.00000000"};
const owner={userId:"42",tokenContract:evidence.tokenContract,address,active:true,chainId:56,currency:"USDT"};
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

test("rejects zero credit and wrong token contract",()=>{
 assert.throws(()=>requireUniqueDepositOwner({...evidence,ledgerAmount:"0.00000000"},[owner]));
 assert.throws(()=>requireUniqueDepositOwner(evidence,[{...owner,tokenContract:"0x"+"d".repeat(40)}]));
 assert.throws(()=>requireUniqueDepositOwner({...evidence,chainId:"97"},[owner]));
});

test("rejects malformed assignment collections and missing wallet identity",()=>{
 for(const assignments of [null,undefined,{},[null],[{}]]) {
  assert.throws(()=>requireUniqueDepositOwner(evidence,assignments));
 }
 for(const candidate of [
  {...owner,userId:"-1"},
  {...owner,userId:"42x"},
  {...owner,address:null},
  {...owner,tokenContract:null},
  {...owner,active:1},
  {...owner,currency:"USDC"}
 ]) {
  assert.throws(()=>requireUniqueDepositOwner(evidence,[candidate]));
 }
});
test("rejects wrong receipt attribution before any posting",()=>{
 for(const changed of [
  {...evidence,depositAddress:"0x"+"d".repeat(40)},
  {...evidence,tokenContract:"0x"+"d".repeat(40)},
  {...evidence,chainId:"1"},
  {...evidence,eventKey:"bsc:97:0x"+"b".repeat(64)+":0"},
  {...evidence,ledgerAmount:"-10.00000000"},
  {...evidence,ledgerAmount:"0.00000001"}
 ]) {
  // A positive dust amount is valid attribution evidence; minimum deposit
  // enforcement belongs to a separately reviewed product policy.
  if(changed.ledgerAmount==="0.00000001") {
   assert.equal(requireUniqueDepositOwner(changed,[owner]).ledgerAmount,"0.00000001");
  } else {
   assert.throws(()=>requireUniqueDepositOwner(changed,[owner]));
  }
 }
});

test("deposit owner identity cannot be rounded or exceed PostgreSQL bigint", () => {
  for (const userId of [Number.MAX_SAFE_INTEGER + 1, "9223372036854775808", "1".repeat(200), { toString: () => "42" }]) {
    assert.throws(() => requireUniqueDepositOwner(evidence, [{ ...owner, userId }]), /ownership mismatch/);
  }
  assert.equal(requireUniqueDepositOwner(evidence, [{ ...owner, userId: "9223372036854775807" }]).userId, "9223372036854775807");
});


test("attribution rejects noncanonical event identity even with a matching owner",()=>{
 const max=((1n<<256n)-1n).toString();
 const prefix="bsc:56:0x"+"b".repeat(64)+":";
 for(const eventKey of [prefix+"00",prefix+"01",prefix+"-1",prefix+"1.0",prefix+"1\n",prefix+(1n<<256n).toString(),prefix+"9".repeat(100),"bsc:56:0x"+"B".repeat(64)+":0"]){
  assert.throws(()=>requireUniqueDepositOwner({...evidence,eventKey},[owner]),/Invalid deposit attribution evidence/);
 }
 for(const index of ["0","1",max]) assert.equal(requireUniqueDepositOwner({...evidence,eventKey:prefix+index},[owner]).eventKey,prefix+index);
});

test("zero destination and token addresses cannot establish ownership",()=>{
 const zero="0x"+"0".repeat(40);
 assert.throws(()=>requireUniqueDepositOwner({...evidence,depositAddress:zero},[{...owner,address:zero}]),/Invalid deposit attribution evidence/);
 assert.throws(()=>requireUniqueDepositOwner({...evidence,tokenContract:zero},[{...owner,tokenContract:zero}]),/Invalid deposit attribution evidence/);
});
