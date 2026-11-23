// Read-only idempotency preflight. This is NOT a substitute for unique
// database constraints or atomic claim-and-post in the eventual writer.
// Caller must use a transaction-scoped PostgreSQL client.
const KEY=/^bsc:56:0x[0-9a-f]{64}:(0|[1-9][0-9]*)$/;
export async function inspectDepositIdempotency(client,{eventKey,schema="public"}){
 if(!client || typeof client.query!=="function" ||
    typeof schema!=="string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema) ||
    typeof eventKey!=="string" || !KEY.test(eventKey) ||
    eventKey.length>160)
  throw new TypeError("Invalid deposit idempotency inspection input");
 const result=await client.query(`
  SELECT
   EXISTS(SELECT 1 FROM "${schema}".verified_deposit_evidence
          WHERE event_key=$1) AS evidence_exists,
   EXISTS(SELECT 1 FROM "${schema}".ledger_transactions
          WHERE idempotency_key=$2) AS ledger_exists
 `,[eventKey,"deposit:"+eventKey]);
 if(!result || !Array.isArray(result.rows) || result.rows.length!==1 ||
    (result.rowCount!==undefined && result.rowCount!==1) ||
    typeof result.rows[0]?.evidence_exists!=="boolean" ||
    typeof result.rows[0]?.ledger_exists!=="boolean")
  throw new Error("Malformed deposit idempotency inspection result");
 if(result.rows[0].evidence_exists || result.rows[0].ledger_exists)
  throw new Error("Deposit event already recorded or pending reconciliation");
 return Object.freeze({eventKey,unrecordedAtInspection:true});
}
