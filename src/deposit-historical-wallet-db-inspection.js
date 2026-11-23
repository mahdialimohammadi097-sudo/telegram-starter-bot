import {verifyHistoricalWalletRecord} from "./deposit-historical-wallet-record.js";

// Read-only historical consistency inspection. Never credits balances.
// Caller must independently verify chain evidence and historical provenance.
export async function inspectHistoricalWalletFromDatabase(client,{eventBlockNumber,walletAddress,expectedUserId,schema="public"}){
 if(typeof schema!=="string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
  throw new TypeError("Invalid schema");
 if(!client || typeof client.query!=="function" || typeof walletAddress!=="string" ||
    !/^0x[0-9a-f]{40}$/.test(walletAddress) ||
    typeof expectedUserId!=="string" || !/^[1-9][0-9]{0,18}$/.test(expectedUserId) || BigInt(expectedUserId)>9223372036854775807n ||
    typeof eventBlockNumber!=="string" || !/^(0|[1-9][0-9]{0,77})$/.test(eventBlockNumber))
  throw new TypeError("Invalid historical inspection input");
 // Lock wallet identity against concurrent changes until the caller transaction ends.
 // Callers must hold an explicit transaction when using this for financial checks.
 const result=await client.query(`
  SELECT h.wallet_id::text,h.user_id::text,h.chain_id::text,
         h.wallet_address,h.start_block::text,h.end_block::text,
         w.id::text AS wallet_id_current,w.chain_id::text AS wallet_chain_id,
         w.wallet_address AS wallet_address_current,
         w.is_platform_controlled
  FROM "${schema}".deposit_address_ownership_history h
  JOIN "${schema}".wallets w ON w.id=h.wallet_id
  WHERE h.chain_id=56 AND h.wallet_address=$1
    AND h.start_block <= $2::numeric
    AND (h.end_block IS NULL OR $2::numeric < h.end_block)
  ORDER BY h.start_block
  LIMIT 2
  FOR SHARE OF h,w`,[walletAddress,eventBlockNumber]);
 // A malformed or incomplete database response is never ownership proof.
 if(!result || !Array.isArray(result.rows) || result.rows.length!==1 ||
    (result.rowCount!==undefined && result.rowCount!==1))
  throw new Error("Missing or ambiguous historical wallet owner");
 const row=result.rows[0];
 return verifyHistoricalWalletRecord({
  history:{wallet_id:row.wallet_id,user_id:row.user_id,chain_id:row.chain_id,
   wallet_address:row.wallet_address,start_block:row.start_block,end_block:row.end_block},
  wallet:{id:row.wallet_id_current,chain_id:row.wallet_chain_id,
   wallet_address:row.wallet_address_current,is_platform_controlled:row.is_platform_controlled},
  eventBlockNumber,expectedUserId
 });
}
