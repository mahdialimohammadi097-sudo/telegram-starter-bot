// Offline-only integration of verified BSC ownership evidence and a balanced
// ledger proposal. No database writes, financial posting, or account creation.
// Caller must provide independently verified account identities; this function
// does not authorize a financial transaction.
import {inspectBscDepositWithHistoricalOwner} from "./bsc-deposit-ownership-preflight.js";
import {validateDepositPostingDraft} from "./deposit-posting-invariants.js";
import {draftBscDepositJournal} from "./deposit-ledger-journal-draft.js";
import {inspectDepositJournalAccounts} from "./deposit-journal-account-db-inspection.js";
export async function prepareBscDepositJournal({
 rpc,client,transactionHash,expected,expectedUserId,
 userAvailableAccountId,platformClearingAccountId,schema="public",lockRows=true
}){
 const evidence=await inspectBscDepositWithHistoricalOwner({
  rpc,client,transactionHash,expected,expectedUserId,schema,lockRows
 });
 const accounts=await inspectDepositJournalAccounts(client,{
  userId:evidence.userId,userAvailableAccountId,platformClearingAccountId,schema,lockRows
 });
 const journal=draftBscDepositJournal({evidence,...accounts});
 validateDepositPostingDraft(journal);
 return Object.freeze({evidence,journal});
}
