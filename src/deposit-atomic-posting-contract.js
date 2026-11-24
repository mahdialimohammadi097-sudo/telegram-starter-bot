// Review-only transaction orchestration. No production adapter or runtime wiring.
// The adapter must own a dedicated disposable test transaction.
import {validateDepositPostingDraft} from "./deposit-posting-invariants.js";
export async function exerciseAtomicDepositPosting(adapter,draft){
 validateDepositPostingDraft(draft);
 const snapshot=structuredClone(draft);
 validateDepositPostingDraft(snapshot);
 for(const method of ["begin","claim","insertLeg","commit","rollback"])
  if(typeof adapter?.[method]!=="function")throw new TypeError("Incomplete test posting adapter");
 await adapter.begin();
 try{
  if(await adapter.claim(snapshot.eventKey,snapshot.idempotencyKey)!==true)
   throw new Error("Deposit identity already claimed or unconfirmed");
  for(const leg of snapshot.entries)
   if(await adapter.insertLeg(snapshot.idempotencyKey,leg)!==true)
    throw new Error("Journal leg insertion unconfirmed");
  await adapter.commit();
  return Object.freeze({status:"fixture_posted",idempotencyKey:snapshot.idempotencyKey});
 }catch(error){
  try{await adapter.rollback()}
  catch{throw new Error("Test posting rollback failed",{cause:error})}
  throw error;
 }
}
