// Pilot-only exact amount gate. A 10 USDT rehearsal must never accept
// a different amount or silently aggregate multiple on-chain transfers.
// This does not authorize a live transfer or post a ledger entry.
export function assertTenUsdtPilotJournal(journal){
 if(!journal || !Array.isArray(journal.entries) ||
    journal.entries.length!==2 ||
    journal.entries[0]?.amount!=="10.00000000" ||
    journal.entries[1]?.amount!=="10.00000000" ||
    journal.entries[0]?.currency!=="USDT" ||
    journal.entries[1]?.currency!=="USDT" ||
    journal.entries[0]?.entry_type!=="debit" ||
    journal.entries[1]?.entry_type!=="credit" ||
    typeof journal.eventKey!=="string" ||
    journal.idempotencyKey!=="deposit:"+journal.eventKey)
  throw new Error("Pilot deposit does not match exactly 10 USDT");
 return journal;
}
