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
