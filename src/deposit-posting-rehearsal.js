// Disposable-test-only orchestration. NOT a live deposit endpoint.
// A separately audited chain verifier and authorization gate are prerequisites.
import {withLedgerTransaction,postJournalInTransaction} from "./ledger-posting.js";
import {normalizeDepositEventIdentity} from "./deposit-event-identity.js";
import {convertDepositBaseUnitsToLedgerUnits} from "./deposit-unit-conversion.js";
export async function rehearseVerifiedDepositPosting({pool,evidence,tokenDecimals,journalForUnits}) {
 if(typeof journalForUnits!=="function") throw new TypeError("Journal builder required");
 const eventKey=normalizeDepositEventIdentity(evidence);
 const units=convertDepositBaseUnitsToLedgerUnits(evidence.amountBaseUnits,tokenDecimals);
 if(!/^0x[0-9a-f]{64}$/.test(evidence.blockHash) ||
    !/^0x[0-9a-f]{40}$/.test(evidence.tokenContract) ||
    !/^0x[0-9a-f]{40}$/.test(evidence.depositAddress) ||
    typeof evidence.blockNumber!=="string" ||
    !/^(0|[1-9][0-9]*)$/.test(evidence.blockNumber))
  throw new TypeError("Invalid evidence fields");
 // Never accept an arbitrary production pool: this helper is a test-only rehearsal.
 if(process.env.PROFINO_DISPOSABLE_POSTGRES!=="yes" ||
    !process.env.DATABASE_URL) throw new Error("Disposable PostgreSQL test mode required");
 const target=new URL(process.env.DATABASE_URL);
 if(!["localhost","127.0.0.1","::1"].includes(target.hostname) ||
    target.pathname!=="/profino_test" ||
    !pool || pool.options?.connectionString!==process.env.DATABASE_URL)
  throw new Error("Unsafe rehearsal database or mismatched pool");
 return withLedgerTransaction(pool,async client=>{
  await client.query(`INSERT INTO verified_deposit_evidence
   (event_key,block_hash,block_number,token_contract,deposit_address,amount_base_units)
   VALUES ($1,$2,$3,$4,$5,$6)`,[eventKey,evidence.blockHash,evidence.blockNumber,evidence.tokenContract,evidence.depositAddress,evidence.amountBaseUnits]);
  const journal=journalForUnits({eventKey,units});
  if(journal?.idempotencyKey!==`verified-deposit:${eventKey}`)
   throw new Error("Deposit journal must use canonical event idempotency key");
  return postJournalInTransaction(client,journal);
 });
}
