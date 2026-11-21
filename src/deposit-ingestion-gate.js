// Explicitly disabled production boundary. No Telegram command or scheduler may
// invoke a financial posting until the final security/accounting release gate.
import {readVerifiedBep20Deposit} from "./bep20-rpc-reader.js";

export function createDisabledDepositIngestion({
 enabled=false, approvedRelease=false, rpc, tokenContract,
 minConfirmations=20
}={}) {
 if(enabled || approvedRelease) {
  throw new Error("Real deposit ingestion requires a separately reviewed production release");
 }
 // Deliberately exposes a read-only verification operation, never a posting action.
 return Object.freeze({
  async inspect({transactionHash,depositAddress}) {
   if(typeof rpc!=="function") throw new Error("Trusted RPC transport is required");
   const events=await readVerifiedBep20Deposit({
    rpc,transactionHash,tokenContract,depositAddress,minConfirmations
   });
   return Object.freeze({verified:true,eventCount:events.length,
    eventKeys:Object.freeze(events.map(event=>event.eventKey))});
  },
  async post() {
   throw new Error("Financial posting is disabled pending explicit launch approval");
  }
 });
}
