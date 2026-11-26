import {runCatalogReadOnlyDepositAudit} from "./read-only-deposit-audit.js";
import {verifyHistoricalWalletRecord,isValidHistoricalBlockNumber} from "./deposit-historical-wallet-record.js";

// Read-only historical consistency inspection. Never credits balances.
// Caller must independently verify chain evidence and historical provenance.
export async function inspectHistoricalWalletSnapshot(pool,{eventBlockNumber,walletAddress,expectedUserId,schema="public"}){
 if(typeof schema!=="string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
  throw new TypeError("Invalid schema");
 if(typeof walletAddress!=="string" || /^0x0{40}$/.test(walletAddress) ||
    !/^0x[0-9a-f]{40}$/.test(walletAddress) ||
    typeof expectedUserId!=="string" || !/^[1-9][0-9]{0,18}$/.test(expectedUserId) || BigInt(expectedUserId)>9223372036854775807n ||
    !isValidHistoricalBlockNumber(eventBlockNumber))
  throw new TypeError("Invalid historical inspection input");
 // Read-only snapshot, not a posting lock or independent historical proof.
 return runCatalogReadOnlyDepositAudit(pool,async client=>{
 // Do not report a consistent owner when a policy hides conflicting rows.
 // This setting does not bypass RLS; PostgreSQL rejects filtered queries.
 const setting=await client.query("SET LOCAL row_security = off");
 const visibility=await client.query("SELECT pg_catalog.current_setting('row_security') AS row_security");
 if(setting?.command!=="SET" || visibility.rows?.length!==1 || visibility.rows[0].row_security!=="off")
  throw new Error("Historical wallet row visibility unconfirmed");
 const result=await client.query(`
  SELECT h.wallet_id::text,h.user_id::text,h.chain_id::text,
         h.wallet_address,h.start_block::text,h.end_block::text,
         w.id::text AS wallet_id_current,w.chain_id::text AS wallet_chain_id,
         w.wallet_address AS wallet_address_current,
         w.is_platform_controlled,u.id::text AS user_id_current
  FROM "${schema}".deposit_address_ownership_history h
  LEFT JOIN "${schema}".wallets w ON w.id=h.wallet_id
  LEFT JOIN "${schema}".users u ON u.id=h.user_id
  WHERE h.chain_id=56 AND lower(h.wallet_address)=$1
    AND h.start_block <= $2::numeric
    AND (h.end_block IS NULL OR $2::numeric < h.end_block)
  ORDER BY h.start_block,h.wallet_id
  LIMIT 2`,[walletAddress,eventBlockNumber]);
 // A malformed or incomplete database response is never ownership proof.
 if(!result || !Array.isArray(result.rows) || result.rows.length!==1 ||
    result.rowCount!==1)
  throw new Error("Missing or ambiguous historical wallet owner");
 const row=result.rows[0];
 // Do not assume a foreign key was enforced when legacy history was inserted.
 if(row.user_id_current!==expectedUserId || row.user_id_current!==row.user_id)
  throw new Error("Historical user identity mismatch");
 verifyHistoricalWalletRecord({
  history:{wallet_id:row.wallet_id,user_id:row.user_id,chain_id:row.chain_id,
   wallet_address:row.wallet_address,start_block:row.start_block,end_block:row.end_block},
  wallet:{id:row.wallet_id_current,chain_id:row.wallet_chain_id,
   wallet_address:row.wallet_address_current,is_platform_controlled:row.is_platform_controlled},
  eventBlockNumber,expectedUserId,expectedWalletAddress:walletAddress
 });
 return Object.freeze({recordConsistent:true,independentHistoricalProof:false,financialActivationReady:false,realDepositsEnabled:false});
 });
}
