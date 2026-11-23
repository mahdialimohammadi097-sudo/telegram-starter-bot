// Pure, offline BSC mainnet receipt gate. Does not fetch RPC data, verify finality
// independently, resolve wallet ownership, or authorize financial crediting.
import {normalizeDepositEventIdentity} from "./deposit-event-identity.js";
import {convertDepositBaseUnitsToLedgerUnits} from "./deposit-unit-conversion.js";
const HASH=/^0x[0-9a-f]{64}$/i;
const ADDRESS=/^0x[0-9a-f]{40}$/i;
const TOPIC="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const rpcBlockNumber=value=>{
 if(typeof value==="number") return Number.isSafeInteger(value) && value>=0 ? value : null;
 if(typeof value!=="string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) return null;
 const number=BigInt(value);
 return number<=BigInt(Number.MAX_SAFE_INTEGER) ? Number(number) : null;
};
const normalizeAddress=value=>typeof value==="string"&&ADDRESS.test(value)?value.toLowerCase():null;
export function inspectBscMainnetTransfer({receipt,chainId,canonicalBlockHash,finalizedBlockNumber,expected}) {
 const receiptBlockNumber=rpcBlockNumber(receipt?.blockNumber);
 const finalityHeight=rpcBlockNumber(finalizedBlockNumber);
 if(chainId!==56 || receipt?.status!=="0x1" || !HASH.test(receipt?.transactionHash) ||
    !HASH.test(receipt?.blockHash) || !HASH.test(canonicalBlockHash) ||
    receipt.blockHash.toLowerCase()!==canonicalBlockHash.toLowerCase() ||
    receiptBlockNumber===null ||
    finalityHeight===null || finalityHeight<receiptBlockNumber ||
    !Number.isSafeInteger(expected?.minConfirmations) || expected.minConfirmations<1 ||
    finalityHeight-receiptBlockNumber+1<expected.minConfirmations)
   throw new Error("Unverified mainnet receipt or block finality");
 const token=normalizeAddress(expected?.tokenContract);
 const recipient=normalizeAddress(expected?.depositAddress);
 if(!token || !recipient || token==="0x"+"0".repeat(40) || recipient==="0x"+"0".repeat(40) ||
    !HASH.test(expected?.transactionHash) ||
    expected.transactionHash.toLowerCase()!==receipt.transactionHash.toLowerCase())
   throw new Error("Unapproved token, recipient or transaction identity");
 const eventKey=normalizeDepositEventIdentity({chainId,transactionHash:receipt.transactionHash,logIndex:expected.logIndex});
 const expectedLogIndex=BigInt(expected.logIndex);
 const matches=(Array.isArray(receipt.logs)?receipt.logs:[]).filter(log=>{
  const index=log?.logIndex;
  if(typeof index==="number") return Number.isSafeInteger(index) && index>=0 && BigInt(index)===expectedLogIndex;
  if(typeof index==="string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(index)) return BigInt(index)===expectedLogIndex;
  return false;
 });
 const log=matches[0];
 const topicRecipient="0x"+recipient.slice(2).padStart(64,"0");
 if(matches.length!==1 || (log.removed!==undefined && log.removed!==false) || log.address?.toLowerCase()!==token ||
    log.transactionHash?.toLowerCase()!==receipt.transactionHash.toLowerCase() ||
    log.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase() ||
    rpcBlockNumber(log.blockNumber)!==receiptBlockNumber ||
    !Array.isArray(log.topics) || log.topics.length!==3 ||
    log.topics[0]?.toLowerCase()!==TOPIC ||
    !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[1]) ||
    /^0x0{64}$/i.test(log.topics[1]) ||
    log.topics[2]?.toLowerCase()!==topicRecipient ||
    log.topics[1]?.toLowerCase()===topicRecipient ||
    !/^0x[0-9a-f]{64}$/i.test(log.data))
   throw new Error("Transfer log does not match configured token and recipient");
 const amountBaseUnits=BigInt(log.data).toString();
 if(BigInt(amountBaseUnits)===0n) throw new Error("Zero-value Transfer is not a deposit");
 const units=convertDepositBaseUnitsToLedgerUnits(amountBaseUnits,expected.tokenDecimals);
 return Object.freeze({eventKey,amountBaseUnits,units,blockHash:receipt.blockHash.toLowerCase(),blockNumber:String(receiptBlockNumber),tokenContract:token,depositAddress:recipient});
}
