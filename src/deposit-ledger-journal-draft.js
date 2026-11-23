// Offline journal proposal only. NEVER posts ledger entries or changes balances.
// A database transaction must independently enforce idempotency, ownership,
// account locks, and balanced posting before real financial use.
import {assertBalancedLedgerEntries} from "./ledger-safety.js";
const KEY=/^bsc:56:0x[0-9a-f]{64}:(0|[1-9][0-9]*)$/;
const ID=/^[1-9][0-9]{0,18}$/;
const MAX_ID=9223372036854775807n;
const validId=v=>typeof v==="string"&&ID.test(v)&&BigInt(v)<=MAX_ID;
export function draftBscDepositJournal({evidence,userAvailableAccountId,platformClearingAccountId}){
 if(!evidence || typeof evidence.eventKey!=="string" || !KEY.test(evidence.eventKey) ||
    !validId(evidence.userId) || !validId(evidence.walletId) ||
    !validId(userAvailableAccountId) || !validId(platformClearingAccountId) ||
    userAvailableAccountId===platformClearingAccountId ||
    typeof evidence.units!=="string" || !/^[1-9][0-9]{0,25}$/.test(evidence.units))
  throw new TypeError("Invalid deposit journal proposal");
 const units=BigInt(evidence.units);
 if(units>10n**26n-1n)throw new RangeError("Deposit exceeds ledger capacity");
 const amount=(units/100000000n).toString()+"."+(units%100000000n).toString().padStart(8,"0");
 const entries=[
  Object.freeze({account_id:platformClearingAccountId,entry_type:"debit",amount,currency:"USDT"}),
  Object.freeze({account_id:userAvailableAccountId,entry_type:"credit",amount,currency:"USDT"})
 ];
 assertBalancedLedgerEntries(entries);
 return Object.freeze({idempotencyKey:"deposit:"+evidence.eventKey,userId:evidence.userId,
  walletId:evidence.walletId,eventKey:evidence.eventKey,entries:Object.freeze(entries)});
}
