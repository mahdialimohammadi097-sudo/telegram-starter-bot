// Offline journal invariant validator; no database writes or runtime wiring.
import {assertBalancedLedgerEntries,toUsdtUnitsExact} from "./ledger-safety.js";
export function validateDepositPostingDraft(draft){
 if(!draft || !Array.isArray(draft.entries) || draft.entries.length!==2 ||
 typeof draft.eventKey!=="string" || !/^bsc:56:0x[0-9a-f]{64}:(0|[1-9][0-9]*)$/.test(draft.eventKey) ||
 draft.idempotencyKey!=="deposit:"+draft.eventKey)
 throw new Error("Invalid deposit posting identity");
 assertBalancedLedgerEntries(draft.entries);
 const [debit,credit]=draft.entries;
 const validId=v=>typeof v==="string"&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
 if(!validId(draft.userId)||!validId(draft.walletId)||!validId(debit.account_id)||!validId(credit.account_id)||
 debit.account_id===credit.account_id||debit.entry_type!=="debit"||credit.entry_type!=="credit"||
 debit.currency!=="USDT"||credit.currency!=="USDT"||
 toUsdtUnitsExact(debit.amount)!==toUsdtUnitsExact(credit.amount))
 throw new Error("Invalid deposit posting legs");
 return true;
}
