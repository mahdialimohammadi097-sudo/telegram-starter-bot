// Pilot-only exact amount gate. A 10 USDT rehearsal must never accept
// a different amount or silently aggregate multiple on-chain transfers.
// This does not authorize a live transfer or post a ledger entry.
import {normalizeDepositEventIdentity} from "./deposit-event-identity.js";
const KEY=/^bsc:56:(0x[0-9a-f]{64}):(0|[1-9][0-9]{0,9})$/;
function validKey(value){
 if(typeof value!=="string")return false;
 const match=KEY.exec(value);
 if(!match)return false;
 try{return normalizeDepositEventIdentity({chainId:56,transactionHash:match[1],logIndex:match[2]})===value;}catch{return false;}
}
const ID=/^[1-9][0-9]{0,18}$/;
const validId=v=>typeof v==="string"&&ID.test(v)&&BigInt(v)<=9223372036854775807n;
export function assertTenUsdtPilotJournal(journal){
 if(!journal || !Array.isArray(journal.entries) ||
    journal.entries.length!==2 ||
    journal.entries[0]?.amount!=="10.00000000" ||
    journal.entries[1]?.amount!=="10.00000000" ||
    journal.entries[0]?.currency!=="USDT" ||
    journal.entries[1]?.currency!=="USDT" ||
    journal.entries[0]?.entry_type!=="debit" ||
    journal.entries[1]?.entry_type!=="credit" ||
    !validKey(journal.eventKey) ||
    !validId(journal.userId) || !validId(journal.walletId) ||
    !validId(journal.entries[0]?.account_id) ||
    !validId(journal.entries[1]?.account_id) ||
    journal.entries[0].account_id===journal.entries[1].account_id ||
    journal.idempotencyKey!=="deposit:"+journal.eventKey)
  throw new Error("Pilot deposit does not match exactly 10 USDT");
 return journal;
}
