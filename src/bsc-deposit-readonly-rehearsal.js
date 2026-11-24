// Safe one-shot read-only rehearsal. No ledger posting and no financial writes.
// Uses a dedicated pg client supplied by the caller, never a shared pool.query.
// Read-only PostgreSQL transactions must not acquire FOR SHARE row locks.
import {prepareBscDepositJournal} from "./bsc-deposit-journal-preparation.js";
import {inspectDepositIdempotency} from "./deposit-idempotency-db-inspection.js";
export async function rehearseBscDepositJournal({client,...input}){
 if(!client || typeof client.query!=="function")
  throw new TypeError("Dedicated PostgreSQL client required");
 let begun=false;
 try{
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  begun=true;
  await client.query("SET LOCAL lock_timeout = '2000ms'");
  await client.query("SET LOCAL statement_timeout = '8000ms'");
  const result=await prepareBscDepositJournal({client,...input,lockRows:false});
  await inspectDepositIdempotency(client,{eventKey:result.evidence.eventKey,schema:input.schema});
  // Always roll back: never commit any transaction in a rehearsal.
  await client.query("ROLLBACK");
  begun=false;
  return result;
 }catch(error){
  if(begun){
   try{await client.query("ROLLBACK")}
   catch{throw new Error("Read-only rehearsal rollback failed",{cause:error})}
  }
  throw error;
 }
}
