// Offline-only integration of verified BSC ownership evidence and a balanced
// ledger proposal. No database writes, financial posting, or account creation.
// Caller must provide independently verified account identities; this function
// does not authorize a financial transaction.
import {inspectBscDepositWithHistoricalOwner} from "./bsc-deposit-ownership-preflight.js";
import {draftBscDepositJournal} from "./deposit-ledger-journal-draft.js";
export async function prepareBscDepositJournal({
 rpc,client,transactionHash,expected,expectedUserId,
 userAvailableAccountId,platformClearingAccountId,schema="public"
}){
 const evidence=await inspectBscDepositWithHistoricalOwner({
  rpc,client,transactionHash,expected,expectedUserId,schema
 });
 const journal=draftBscDepositJournal({
  evidence,userAvailableAccountId,platformClearingAccountId
 });
 return Object.freeze({evidence,journal});
}
