import test from "node:test";
import assert from "node:assert/strict";
import { validateBep20DepositObservation } from "./bep20-deposit-observation.js";

const a = "0x" + "a".repeat(40);
const b = "0x" + "b".repeat(40);
const c = "0x" + "c".repeat(40);
const tx = "0x" + "d".repeat(64);
const policy = {chainId:56,tokenContract:a,depositAddress:b,tokenDecimals:18,confirmedHeadBlock:120,minConfirmations:12};
const event = {chainId:56,tokenContract:a,to:b,from:c,txHash:tx,logIndex:0,amountBaseUnits:"1000000000000000000",removed:false,receiptStatus:1,blockNumber:109};

test("accepts a fully matched, confirmed transfer observation without crediting funds",()=>{
 const result=validateBep20DepositObservation(event,policy);
 assert.equal(result.eventKey,"bsc:56:"+tx+":0");
 assert.equal(result.amountBaseUnits,"1000000000000000000");
});
test("rejects mismatched network, contract and recipient",()=>{
 for(const changed of [{chainId:1},{tokenContract:c},{to:c}]) assert.throws(()=>validateBep20DepositObservation({...event,...changed},policy));
});
test("rejects failed, removed, immature and zero transfers",()=>{
 for(const changed of [{removed:true},{receiptStatus:0},{amountBaseUnits:"0"},{blockNumber:110}]) assert.throws(()=>validateBep20DepositObservation({...event,...changed},policy));
});
test("distinguishes multiple transfer logs in one transaction",()=>{
 assert.notEqual(validateBep20DepositObservation(event,policy).eventKey,validateBep20DepositObservation({...event,logIndex:1},policy).eventKey);
});
test("rejects unsafe numeric amounts and malformed hashes",()=>{
 assert.throws(()=>validateBep20DepositObservation({...event,amountBaseUnits:Number.MAX_SAFE_INTEGER+1},policy));
 assert.throws(()=>validateBep20DepositObservation({...event,txHash:"0x123"},policy));
});

test("rejects quantities outside the blockchain uint256 range",()=>{
 const overflow=(1n<<256n).toString();
 for(const change of [{amountBaseUnits:overflow},{logIndex:overflow},{blockNumber:overflow},{amountBaseUnits:"9".repeat(10000)}]){
  assert.throws(()=>validateBep20DepositObservation({...event,...change},policy),/Invalid/);
 }
});

test("rejects self-transfers and zero sender observations",()=>{
 for(const from of [event.to,"0x"+"0".repeat(40)]){
  assert.throws(()=>validateBep20DepositObservation({...event,from},policy),/Invalid transfer sender/);
 }
});
