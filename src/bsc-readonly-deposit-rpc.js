// Read-only BSC RPC evidence adapter. Caller owns the trusted RPC transport and
// approved token policy. Never writes to the database or credits balances.
import {inspectBscMainnetTransfer} from "./bsc-mainnet-transfer-inspection.js";
const HASH=/^0x[0-9a-f]{64}$/i;
const Q=/^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const height=value=>{
 if(typeof value!=="string" || !Q.test(value)) throw new Error("Invalid RPC block quantity");
 const n=BigInt(value);
 if(n>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe RPC block quantity");
 return Number(n);
};
export async function readBscDepositEvidence({rpc,transactionHash,expected}){
 if(typeof rpc!=="function" || !HASH.test(transactionHash) ||
    !expected || expected.transactionHash?.toLowerCase()!==transactionHash.toLowerCase())
  throw new Error("Invalid read-only BSC evidence request");
 const request=async(method,params)=>{
  const result=await rpc(method,params);
  if(result===null || result===undefined) throw new Error("Missing RPC evidence");
  return result;
 };
 if(await request("eth_chainId",[])!=="0x38") throw new Error("Unexpected RPC chain");
 const receipt=await request("eth_getTransactionReceipt",[transactionHash]);
 if(!receipt || receipt.transactionHash?.toLowerCase()!==transactionHash.toLowerCase())
  throw new Error("RPC receipt identity mismatch");
 const transaction=await request("eth_getTransactionByHash",[transactionHash]);
 if(!transaction || transaction.hash?.toLowerCase()!==transactionHash.toLowerCase() ||
    transaction.blockHash?.toLowerCase()!==receipt.blockHash?.toLowerCase() ||
    transaction.blockNumber!==receipt.blockNumber)
  throw new Error("RPC transaction provenance mismatch");
 const blockHeight=height(receipt.blockNumber);
 const blockTag="0x"+blockHeight.toString(16);
 const first=await request("eth_getBlockByNumber",[blockTag,false]);
 const head=await request("eth_blockNumber",[]);
 const second=await request("eth_getBlockByNumber",[blockTag,false]);
 if(!first || !second || !HASH.test(first.hash) || !HASH.test(second.hash) ||
    first.hash.toLowerCase()!==second.hash.toLowerCase() ||
    height(first.number)!==blockHeight || height(second.number)!==blockHeight ||
    receipt.blockHash?.toLowerCase()!==second.hash.toLowerCase())
  throw new Error("RPC canonical block mismatch");
 const latestReceipt=await request("eth_getTransactionReceipt",[transactionHash]);
 if(!latestReceipt ||
    latestReceipt.transactionHash?.toLowerCase()!==receipt.transactionHash.toLowerCase() ||
    latestReceipt.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase() ||
    latestReceipt.blockNumber!==receipt.blockNumber ||
    latestReceipt.status!==receipt.status ||
    !Array.isArray(latestReceipt.logs) ||
    JSON.stringify(latestReceipt.logs)!==JSON.stringify(receipt.logs))
  throw new Error("RPC receipt changed during evidence inspection");
 if(await request("eth_chainId",[])!=="0x38")
  throw new Error("RPC chain changed during evidence inspection");
 const finalizedBlockNumber=height(head);
 // This head is confirmation-depth evidence, not independently verified finality.
 return inspectBscMainnetTransfer({receipt:latestReceipt,chainId:56,
  canonicalBlockHash:second.hash,finalizedBlockNumber,expected});
}
