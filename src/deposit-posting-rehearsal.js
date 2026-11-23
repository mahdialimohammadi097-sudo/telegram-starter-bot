// Disposable-test-only orchestration. NOT a live deposit endpoint.
// A separately audited chain verifier and authorization gate are prerequisites.
import {withLedgerTransaction,postJournalInTransaction} from "./ledger-posting.js";
import {normalizeDepositEventIdentity} from "./deposit-event-identity.js";
import {convertDepositBaseUnitsToLedgerUnits} from "./deposit-unit-conversion.js";
import {toUsdtUnitsExact} from "./ledger-safety.js";
import {lockDepositDestinationAccount} from "./deposit-destination-account-lock.js";
export async function rehearseVerifiedDepositPosting({pool,evidence,tokenDecimals,journalForUnits,destinationOwner}) {
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
  // Reject missing ownership before invoking caller-controlled journal construction.
  // Any inserted evidence is rolled back by the enclosing transaction.
  if(destinationOwner===undefined)
   throw new Error("Verified deposit destination owner required");
  await lockDepositDestinationAccount(client,destinationOwner);
  const journal=journalForUnits({eventKey,units});
  // Deposit evidence must not be booked under a different accounting category.
  if(journal?.transactionType!=="deposit")
   throw new Error("Deposit journal must use deposit transaction type");
  if(journal?.idempotencyKey!==`verified-deposit:${eventKey}`)
   throw new Error("Deposit journal must use canonical event idempotency key");
  // A balanced but inflated journal must never credit more than chain evidence.
  if(!Array.isArray(journal.entries) || journal.entries.length!==2)
   throw new Error("Deposit rehearsal requires exactly two ledger entries");
  const debit=journal.entries.find(x=>x.entry_type==="debit");
  const credit=journal.entries.find(x=>x.entry_type==="credit");
  if(!debit || !credit || journal.entries.some(x=>x.currency!=="USDT") ||
     toUsdtUnitsExact(debit.amount)!==BigInt(units) ||
     toUsdtUnitsExact(credit.amount)!==BigInt(units))
   throw new Error("Deposit journal amount must exactly match verified token units");
  if(String(credit.account_id)!==String(destinationOwner.accountId) ||
     String(debit.account_id)===String(destinationOwner.accountId))
   throw new Error("Deposit journal credit must target locked customer account");
  // A deposit must originate from a platform clearing account, never another
  // customer's AVAILABLE balance. Lock the source inside this transaction.
  const source=await client.query(`SELECT id FROM ledger_accounts
   WHERE id=$1::bigint AND account_type='CLEARING' AND currency='USDT'
     AND user_id IS NULL FOR UPDATE`,[String(debit.account_id)]);
  if(source.rowCount!==1 || String(source.rows?.[0]?.id)!==String(BigInt(String(debit.account_id))))
   throw new Error("Deposit source must be a platform clearing account");
  return postJournalInTransaction(client,journal);
 });
}
