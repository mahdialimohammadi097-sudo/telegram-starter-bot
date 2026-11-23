// Exact 10 USDT pilot rehearsal; never sends funds or posts ledger writes.
import {rehearseBscDepositJournal} from "./bsc-deposit-readonly-rehearsal.js";
import {assertTenUsdtPilotJournal} from "./ten-usdt-pilot-gate.js";
export async function rehearseTenUsdtBscPilot(input){
 const result=await rehearseBscDepositJournal(input);
 assertTenUsdtPilotJournal(result.journal);
 return result;
}
