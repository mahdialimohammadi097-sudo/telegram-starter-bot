import test from "node:test";
import assert from "node:assert/strict";
import {inspectBscMainnetTransfer} from "./bsc-mainnet-transfer-inspection.js";
const tx="0x"+"a".repeat(64),block="0x"+"b".repeat(64),token="0x"+"c".repeat(40),recipient="0x"+"d".repeat(40);
const topic="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const sender="0x"+"0".repeat(24)+"e".repeat(40);
const log={logIndex:2,removed:false,address:token,transactionHash:tx,blockHash:block,blockNumber:100,
 topics:[topic,sender,"0x"+"0".repeat(24)+recipient.slice(2)],data:"0x"+(10n**18n).toString(16).padStart(64,"0")};
const input={chainId:56,canonicalBlockHash:block,finalizedBlockNumber:120,
 receipt:{status:"0x1",transactionHash:tx,blockHash:block,blockNumber:100,logs:[log]},
 expected:{tokenContract:token,depositAddress:recipient,transactionHash:tx,logIndex:2,tokenDecimals:18,minConfirmations:12}};
test("accepts exact mainnet transfer log without crediting balances",()=>{
 const result=inspectBscMainnetTransfer(input);
 assert.equal(result.eventKey,"bsc:56:"+tx+":2");
 assert.equal(result.units,"100000000");
});
test("rejects wrong chain, token, recipient, unfinalized block and removed log",()=>{
 const variants=[
  {...input,chainId:97},
  {...input,expected:{...input.expected,tokenContract:"0x"+"f".repeat(40)}},
  {...input,expected:{...input.expected,depositAddress:"0x"+"f".repeat(40)}},
  {...input,finalizedBlockNumber:99},
  {...input,receipt:{...input.receipt,logs:[{...log,removed:true}]}},
  {...input,receipt:{...input.receipt,logs:[log,log]}}
 ];
 for(const value of variants)assert.throws(()=>inspectBscMainnetTransfer(value));
});
test("rejects loss of ledger precision",()=>{
 const value={...input,receipt:{...input.receipt,logs:[{...log,data:"0x"+(10n**18n+1n).toString(16).padStart(64,"0")}]}};
 assert.throws(()=>inspectBscMainnetTransfer(value),/exactly/);
});

test("rejects zero sender, self-transfer and malformed sender topic",()=>{
 const recipientTopic="0x"+"0".repeat(24)+recipient.slice(2);
 for(const senderTopic of ["0x"+"0".repeat(64),recipientTopic,"0x1234"]){
  const value={...input,receipt:{...input.receipt,logs:[{...log,topics:[topic,senderTopic,recipientTopic]}]}};
  assert.throws(()=>inspectBscMainnetTransfer(value),/Transfer log/);
 }
});

test("rejects missing or insufficient configured confirmations",()=>{
 for(const confirmations of [undefined,0,22]){
  const value={...input,expected:{...input.expected,minConfirmations:confirmations}};
  assert.throws(()=>inspectBscMainnetTransfer(value),/finality/);
 }
});

test("rejects mismatched canonical block hash, receipt transaction and log provenance",()=>{
 const otherHash="0x"+"f".repeat(64);
 const variants=[
  {...input,canonicalBlockHash:otherHash},
  {...input,expected:{...input.expected,transactionHash:otherHash}},
  {...input,receipt:{...input.receipt,transactionHash:otherHash}},
  {...input,receipt:{...input.receipt,logs:[{...log,blockHash:otherHash}]}},
  {...input,receipt:{...input.receipt,logs:[{...log,transactionHash:otherHash}]}},
  {...input,receipt:{...input.receipt,logs:[{...log,blockNumber:101}]}},
  {...input,receipt:{...input.receipt,logs:[{...log,logIndex:3}]}},
  {...input,receipt:{...input.receipt,status:"0x0"}}
 ];
 for(const value of variants) assert.throws(()=>inspectBscMainnetTransfer(value));
});

test("rejects forged confirmation count and malformed receipt provenance",()=>{
 const variants=[
  {...input,finalizedBlockNumber:100,expected:{...input.expected,minConfirmations:2}},
  {...input,finalizedBlockNumber:100.5},
  {...input,receipt:{...input.receipt,blockNumber:100.5}},
  {...input,receipt:{...input.receipt,logs:[{...log,topics:[topic,sender]}]}},
  {...input,receipt:{...input.receipt,logs:[{...log,topics:[topic,sender,"0x"+"0".repeat(64)]}]}},
  {...input,receipt:{...input.receipt,logs:[{...log,data:"0x1234"}]}},
  {...input,receipt:{...input.receipt,logs:[{...log,removed:"false"}]}},
  {...input,receipt:{...input.receipt,logs:[{...log,address:"0x"+"f".repeat(40)}]}}
 ];
 for(const value of variants)assert.throws(()=>inspectBscMainnetTransfer(value));
});

test("rejects zero-value Transfer logs as non-deposits",()=>{
 const value={...input,receipt:{...input.receipt,logs:[{...log,data:"0x"+"0".repeat(64)}]}};
 assert.throws(()=>inspectBscMainnetTransfer(value),/Zero-value/);
});

test("accepts mined receipt logs where removed is omitted",()=>{
 const {removed,...minedLog}=log;
 const value={...input,receipt:{...input.receipt,logs:[minedLog]}};
 assert.equal(inspectBscMainnetTransfer(value).eventKey,"bsc:56:"+tx+":2");
});

test("accepts canonical hex RPC log index and rejects malformed or ambiguous indices",()=>{
 const hexLog={...log,logIndex:"0x2"};
 const value={...input,receipt:{...input.receipt,logs:[hexLog]}};
 assert.equal(inspectBscMainnetTransfer(value).eventKey,"bsc:56:"+tx+":2");
 for(const badIndex of ["0x02","0xzz","2",-1,2.5]){
  const invalid={...input,receipt:{...input.receipt,logs:[{...log,logIndex:badIndex}]}};
  assert.throws(()=>inspectBscMainnetTransfer(invalid));
 }
 assert.throws(()=>inspectBscMainnetTransfer({...input,receipt:{...input.receipt,logs:[log,hexLog]}}));
});

test("accepts canonical hexadecimal RPC block heights without losing precision",()=>{
 const value={...input,receipt:{...input.receipt,blockNumber:"0x64",logs:[{...log,blockNumber:"0x64",logIndex:"0x2"}]}};
 assert.equal(inspectBscMainnetTransfer(value).blockNumber,"100");
});
test("rejects malformed or unsafe RPC block heights",()=>{
 for(const bad of ["0x064","0xzz","0x20000000000000",-1,100.5]){
  const value={...input,receipt:{...input.receipt,blockNumber:bad}};
  assert.throws(()=>inspectBscMainnetTransfer(value));
 }
});

test("accepts canonical hexadecimal finalized head height",()=>{
 const value={...input,finalizedBlockNumber:"0x78"};
 assert.equal(inspectBscMainnetTransfer(value).blockNumber,"100");
});
test("rejects malformed or unsafe finalized head height",()=>{
 for(const bad of ["0x078","0xzz","0x20000000000000",-1,120.5]){
  assert.throws(()=>inspectBscMainnetTransfer({...input,finalizedBlockNumber:bad}),/finality/);
 }
});

test("rejects a Transfer log with a different transaction index",()=>{
 const receipt={...input.receipt,transactionIndex:"0x2",logs:[{...log,transactionIndex:"0x3"}]};
 assert.throws(()=>inspectBscMainnetTransfer({...input,receipt}),/Transfer log/);
});
test("accepts matching receipt and log transaction indexes",()=>{
 const receipt={...input.receipt,transactionIndex:"0x2",logs:[{...log,transactionIndex:"0x2"}]};
 assert.equal(inspectBscMainnetTransfer({...input,receipt}).units,"100000000");
});

test("fails closed on missing or malformed transaction position evidence",()=>{
 const variants=[
  {receiptIndex:"0x2",logIndex:undefined},
  {receiptIndex:undefined,logIndex:"0x2"},
  {receiptIndex:"bad",logIndex:"bad"},
  {receiptIndex:"0x2",logIndex:"bad"}
 ];
 for(const v of variants){
  const receipt={...input.receipt,transactionIndex:v.receiptIndex,
   logs:[{...log,transactionIndex:v.logIndex}]};
  assert.throws(()=>inspectBscMainnetTransfer({...input,receipt}),/Transfer log/);
 }
});

test("rejects malformed transfer fields without coercion",()=>{
 for(const patch of [{data:log.data+"\n"},{data:[log.data]},{logIndex:"0x2\n"},{logIndex:"0x"+"f".repeat(1000)},{topics:[topic,sender+"\n",log.topics[2]]}]){
  assert.throws(()=>inspectBscMainnetTransfer({...input,receipt:{...input.receipt,logs:[{...log,...patch}]}}));
 }
 for(const finalizedBlockNumber of ["0x78\n","0x"+"f".repeat(1000)])assert.throws(()=>inspectBscMainnetTransfer({...input,finalizedBlockNumber}));
});
