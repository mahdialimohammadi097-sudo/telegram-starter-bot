// Read-only BSC RPC evidence adapter. Caller owns the trusted RPC transport and
// approved token policy. Never writes to the database or credits balances.
import {inspectBscMainnetTransfer} from "./bsc-mainnet-transfer-inspection.js";
const HASH=/^0x[0-9a-f]{64}$/i;
const validHash=value=>typeof value==="string" && value.length===66 && HASH.test(value);
const Q=/^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const height=value=>{
 if(typeof value!=="string" || value.length>16 || !Q.test(value) || /\s/.test(value)) throw new Error("Invalid RPC block quantity");
 const n=BigInt(value);
 if(n>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe RPC block quantity");
 return Number(n);
};
export async function readBscDepositEvidence({rpc,transactionHash,expected}){
 if(typeof rpc!=="function" || !validHash(transactionHash) ||
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
    transaction.blockNumber!==receipt.blockNumber ||
    ((receipt.transactionIndex!==undefined || transaction.transactionIndex!==undefined) &&
    (receipt.transactionIndex===undefined || transaction.transactionIndex===undefined ||
     receipt.transactionIndex!==transaction.transactionIndex)))
  throw new Error("RPC transaction provenance mismatch");
 const blockHeight=height(receipt.blockNumber);
 const blockTag="0x"+blockHeight.toString(16);
 const first=await request("eth_getBlockByNumber",[blockTag,false]);
 const head=await request("eth_blockNumber",[]);
 const second=await request("eth_getBlockByNumber",[blockTag,false]);
 if(!first || !second || !validHash(first.hash) || !validHash(second.hash) ||
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
    latestReceipt.transactionIndex!==receipt.transactionIndex ||
    !Array.isArray(latestReceipt.logs) ||
    JSON.stringify(latestReceipt.logs)!==JSON.stringify(receipt.logs))
  throw new Error("RPC receipt changed during evidence inspection");
 const latestTransaction=await request("eth_getTransactionByHash",[transactionHash]);
 if(!latestTransaction ||
    latestTransaction.hash?.toLowerCase()!==transaction.hash.toLowerCase() ||
    latestTransaction.blockHash?.toLowerCase()!==transaction.blockHash.toLowerCase() ||
    latestTransaction.blockNumber!==transaction.blockNumber ||
    latestTransaction.transactionIndex!==transaction.transactionIndex)
  throw new Error("RPC transaction changed during evidence inspection");
 if(await request("eth_chainId",[])!=="0x38")
  throw new Error("RPC chain changed during evidence inspection");
 const finalizedBlockNumber=height(head);
 const latestHead=height(await request("eth_blockNumber",[]));
 if(latestHead<finalizedBlockNumber)
  throw new Error("RPC head regressed during evidence inspection");
 const finalBlock=await request("eth_getBlockByNumber",[blockTag,false]);
 if(!finalBlock || !validHash(finalBlock.hash) ||
    finalBlock.hash.toLowerCase()!==second.hash.toLowerCase() ||
    height(finalBlock.number)!==blockHeight)
  throw new Error("RPC canonical block changed after final receipt inspection");
 // This head is confirmation-depth evidence, not independently verified finality.
 return inspectBscMainnetTransfer({receipt:latestReceipt,chainId:56,
  canonicalBlockHash:second.hash,finalizedBlockNumber,expected});
}
