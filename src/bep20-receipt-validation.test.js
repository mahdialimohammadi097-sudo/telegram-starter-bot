import test from "node:test";
import assert from "node:assert/strict";
import { validateBep20Receipt } from "./bep20-receipt-validation.js";

const a = "0x" + "a".repeat(40), b = "0x" + "b".repeat(40), c = "0x" + "c".repeat(40);
const h = "0x" + "d".repeat(64), blockHash = "0x" + "e".repeat(64);
const topic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const addressTopic = x => "0x" + x.slice(2).padStart(64,"0");
const log = {address:a,topics:[topic,addressTopic(c),addressTopic(b)],data:"0x"+(10n**18n).toString(16).padStart(64,"0"),transactionHash:h,blockHash,blockNumber:"0x6d",logIndex:"0x0",removed:false};
const receipt = {transactionHash:h,blockHash,blockNumber:"0x6d",status:"0x1",logs:[log]};
const canonical = {hash:blockHash,number:"0x6d"};
const policy = {chainId:56,tokenContract:a,depositAddress:b,tokenDecimals:18,confirmedHeadBlock:120,minConfirmations:12};
const check = (r=receipt,i="0x0",blk=canonical,p=policy)=>validateBep20Receipt(r,i,blk,p);

test("verified receipt transfer produces a stable event identity",()=>{
 assert.equal(check().eventKey,"bsc:56:"+h+":0");
 assert.equal(check().amountBaseUnits,(10n**18n).toString());
});
test("rejects forged contract, recipient and transfer signature",()=>{
 for(const changed of [{address:c},{topics:[topic,addressTopic(c),addressTopic(a)]},{topics:["0x"+"0".repeat(64),addressTopic(c),addressTopic(b)]}])
   assert.throws(()=>check({...receipt,logs:[{...log,...changed}]}));
});
test("rejects reorg, failed transaction and immature confirmation",()=>{
 assert.throws(()=>check(receipt,"0x0",{...canonical,hash:h}));
 assert.throws(()=>check({...receipt,status:"0x0"}));
 assert.throws(()=>check(receipt,"0x0",canonical,{...policy,confirmedHeadBlock:110}));
});
test("rejects log identity mismatch, removed logs and duplicate indices",()=>{
 assert.throws(()=>check(receipt,"0x1"));
 assert.throws(()=>check({...receipt,logs:[{...log,removed:true}]}));
 assert.throws(()=>check({...receipt,logs:[log,log]}));
});

test("accepts mined receipt logs without optional removed flag",()=>{
 const {removed, ...minedLog}=log;
 assert.equal(check({...receipt,logs:[minedLog]}).eventKey,"bsc:56:"+h+":0");
});
test("rejects malformed removed flags",()=>{
 for(const removed of [null,0,"false",1]) assert.throws(()=>check({...receipt,logs:[{...log,removed}]}));
});

test("rejects nonprimitive receipt and log fields without implicit coercion",()=>{
 const fake=value=>({toString:()=>value,toLowerCase:()=>value.toLowerCase()});
 for(const field of ["transactionHash","blockHash"]) assert.throws(()=>check({...receipt,[field]:fake(receipt[field])}),/canonical block mismatch/);
 for(const field of ["address","data","transactionHash","blockHash"]) assert.throws(()=>check({...receipt,logs:[{...log,[field]:fake(log[field])}]}),/Invalid transfer log/);
 assert.throws(()=>check({...receipt,logs:[{...log,topics:[null,...log.topics.slice(1)]}]}),/Invalid transfer log/);
 assert.throws(()=>check({...receipt,logs:[null,log]}),/Invalid receipt log/);
});
