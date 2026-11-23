// Read-only composition of independently checked chain evidence and historical
// wallet ownership. The caller must supply an approved policy, trusted RPC,
// and a database client inside a caller-managed transaction. No ledger writes.
import {readBscDepositEvidence} from "./bsc-readonly-deposit-rpc.js";
import {inspectHistoricalWalletFromDatabase} from "./deposit-historical-wallet-db-inspection.js";
export async function inspectBscDepositWithHistoricalOwner({
 rpc,client,transactionHash,expected,expectedUserId,schema="public",lockRows=true
}){
 if(!expected || typeof expected.depositAddress!=="string" ||
    !/^0x[0-9a-f]{40}$/i.test(expected.depositAddress))
  throw new TypeError("Invalid approved deposit address");
 const evidence=await readBscDepositEvidence({rpc,transactionHash,expected});
 const owner=await inspectHistoricalWalletFromDatabase(client,{
  walletAddress:evidence.depositAddress,
  eventBlockNumber:evidence.blockNumber,
  expectedUserId,schema,lockRows
 });
 if(owner.userId!==expectedUserId)throw new Error("Historical wallet owner mismatch");
 return Object.freeze({...evidence,walletId:owner.walletId,userId:owner.userId});
}
