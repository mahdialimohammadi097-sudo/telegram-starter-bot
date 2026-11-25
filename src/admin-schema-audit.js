import { safeDiagnosticCode } from "./diagnostic-safety.js";
import { auditDepositSchema } from "./deposit-schema-audit.js";
import { rollbackTransaction } from "./transaction-safety.js";
// Basic historical guard inventory, not proof of function bodies, interval semantics,
// effective privileges or historical provenance. A missing guard must fail closed.
export async function inspectHistoricalGuardInventory(client,schema="public") {
 const result=await client.query(`
  SELECT c.relkind='r' AND c.relpersistence='p'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhparent=c.oid OR i.inhrelid=c.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid)
    AND (SELECT count(*) FROM pg_catalog.pg_trigger tg
      WHERE tg.tgrelid=c.oid AND NOT tg.tgisinternal)=3
    AND (SELECT count(*) FROM pg_catalog.pg_trigger tg
      JOIN pg_catalog.pg_proc p ON p.oid=tg.tgfoid
      JOIN pg_catalog.pg_namespace fn ON fn.oid=p.pronamespace
      WHERE tg.tgrelid=c.oid AND NOT tg.tgisinternal AND tg.tgenabled='A'
        AND tg.tgqual IS NULL AND tg.tgnargs=0 AND tg.tgconstraint=0
        AND fn.nspname=$1 AND NOT p.prosecdef
        AND ((tg.tgname='deposit_ownership_wallet_identity' AND tg.tgtype=7
             AND p.proname='validate_deposit_ownership_wallet_identity')
          OR (tg.tgname='deposit_ownership_history_immutable' AND tg.tgtype=27
             AND p.proname='reject_deposit_ownership_history_mutation')
          OR (tg.tgname='deposit_ownership_history_no_truncate' AND tg.tgtype=34
             AND p.proname='reject_deposit_ownership_history_mutation')))=3
    AND (SELECT count(*) FROM pg_catalog.pg_constraint co
      JOIN pg_catalog.pg_index ix ON ix.indexrelid=co.conindid
      WHERE co.conrelid=c.oid AND co.contype='x' AND co.convalidated
        AND NOT co.condeferrable AND ix.indisvalid AND ix.indisready AND ix.indislive AND ix.indisexclusion
        AND co.conname IN ('ownership_wallet_interval_no_overlap','ownership_interval_no_overlap'))=2
    AS basic_guards_present
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace ns ON ns.oid=c.relnamespace
  WHERE ns.nspname=$1 AND c.relname='deposit_address_ownership_history'
 `,[schema]);
 return result.rows?.length===1 && result.rows[0].basic_guards_present===true;
}

// Read-only, one-shot structural diagnostic for the existing production database.
// No user rows, wallet addresses, balances or secrets are queried or returned.
export async function inspectDepositSchemaReadOnly(pool) {
 const required={
  users:["id"],
  verified_deposit_evidence:["event_key","block_hash","block_number","token_contract","deposit_address","amount_base_units"],
  wallets:["id","wallet_address","chain_id","is_platform_controlled"],
  ledger_accounts:["id","user_id","account_type","currency"],
  ledger_transactions:["id","idempotency_key","status","transaction_type","reference_id"],
  ledger_entries:["transaction_id","account_id","entry_type","amount","currency"],
  user_wallet_assignments:["id","user_id","wallet_id","assignment_type","status","ended_at"],
  deposit_address_ownership_history:["id","wallet_id","user_id","chain_id","wallet_address","start_block","end_block","recorded_at","verified_source"]
 };
 const client=await pool.connect();
 let releaseError;
 let transactionOpen=false;
 try {
  const started=await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
  if(started?.command!=="BEGIN")throw new Error("Schema audit transaction start unconfirmed");
  transactionOpen=true;
  const statementLimit=await client.query("SET LOCAL statement_timeout = '5000ms'");
  const lockLimit=await client.query("SET LOCAL lock_timeout = '3000ms'");
  if(statementLimit?.command!=="SET"||lockLimit?.command!=="SET")throw new Error("Schema audit time limits unconfirmed");
  const state=await client.query(`SELECT pg_catalog.current_setting('transaction_read_only') AS read_only,
   pg_catalog.current_setting('transaction_isolation') AS isolation,
   pg_catalog.current_setting('statement_timeout') AS statement_timeout,
   pg_catalog.current_setting('lock_timeout') AS lock_timeout`);
  const settings=state.rows?.[0];
  if(state.rows?.length!==1||settings?.read_only!=="on"||settings.isolation!=="repeatable read"||settings.statement_timeout!=="5s"||settings.lock_timeout!=="3s")throw new Error("Schema audit transaction settings incompatible");
  const result=await client.query(`SELECT table_name,column_name,data_type FROM information_schema.columns
   WHERE table_schema='public' AND table_name=ANY($1::text[])`,[Object.keys(required)]);
  const present=new Set(result.rows.map(r=>r.table_name+"."+r.column_name));
  const missing=Object.entries(required).flatMap(([table,columns])=>
   columns.filter(column=>!present.has(table+"."+column)).map(column=>table+"."+column));
  // Metadata-only compatibility check for reviewed historical-ownership migration.
  // Never inspect user rows or infer financial activation from type matches.
  const expectedTypes={
   "users.id":"bigint",
   "wallets.id":"bigint",
   "wallets.chain_id":"integer",
   "user_wallet_assignments.user_id":"bigint",
   "user_wallet_assignments.wallet_id":"bigint"
  };
  const observedTypes=Object.fromEntries(result.rows
   .filter(r=>Object.hasOwn(expectedTypes,r.table_name+"."+r.column_name))
   .map(r=>[r.table_name+"."+r.column_name,r.data_type??"unknown"]));
  // The historical migration accepts both int4 and int8 chain IDs.
  // Keep the stricter bigint contract for existing user and wallet keys.
  const incompatibleTypes=Object.entries(expectedTypes).filter(([key,type])=>
   key==="wallets.chain_id"
    ? !["integer","bigint"].includes(observedTypes[key])
    : observedTypes[key]!==type).map(([key,type])=>({
    column:key,expected:key==="wallets.chain_id"?"integer or bigint":type,observed:observedTypes[key]??"missing"
   }));
  const indexes=await client.query(`SELECT t.relname AS table_name,a.attname AS column_name
   FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
   JOIN pg_namespace n ON n.oid=t.relnamespace
   JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
   WHERE n.nspname='public' AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate
    AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=1
    AND ((t.relname='verified_deposit_evidence' AND a.attname='event_key')
      OR (t.relname='ledger_transactions' AND a.attname='idempotency_key'))`);
  const uniqueKeys=new Set(indexes.rows.map(r=>r.table_name+"."+r.column_name));
  for(const key of ["verified_deposit_evidence.event_key","ledger_transactions.idempotency_key"])
   if(!uniqueKeys.has(key))missing.push("unique:"+key);
  // Legacy metadata remains useful for migration review, but cannot certify
  // the stronger shared catalog contract (nullability, precision, FK and CHECK).
  const catalog=await auditDepositSchema(client);
  for(const column of catalog.missing) if(!missing.includes(column)) missing.push(column);
  const historicalBasicGuardsPresent=await inspectHistoricalGuardInventory(client);
  transactionOpen=false;
  const completion=await client.query("ROLLBACK");
  if(completion?.command!=="ROLLBACK")throw new Error("Schema audit rollback unconfirmed");
  return {audit:"deposit-schema",structuralReady:missing.length===0&&catalog.ready&&incompatibleTypes.length===0&&historicalBasicGuardsPresent,missing,
   historicalBasicGuardsPresent,
   catalogIncompatible:catalog.incompatible,
   migrationTypeCompatible:incompatibleTypes.length===0,incompatibleTypes,
   financialActivationReady:false,realDepositsEnabled:false,
   outstandingSecurityGates:["historical-schema-definition-and-effective-privilege-review","independent-historical-ownership-proof","independent-chain-finality-verification","production-backup-restore","owner-financial-authorization"]};
 } catch(error) {
  // Failed BEGIN or unconfirmed completion must not return the session to the pool.
  if(transactionOpen){
   const rollbackError=await rollbackTransaction(client,error);
   if(rollbackError)releaseError=new Error("schema_audit_rollback_failed");
  }else{
   releaseError=error instanceof Error?error:new Error("schema_audit_session_uncertain");
  }
  throw error;
 } finally {client.release(releaseError);}
}

/**
 * Send only an allowlisted metadata report. Errors are deliberately swallowed:
 * diagnostics must never prevent the existing Telegram bot from starting.
 */
export async function deliverAdminSchemaAudit({pool,sendMessage,adminId,logCode=()=>{}}) {
 try {
  const audit=await inspectDepositSchemaReadOnly(pool);
  await sendMessage(adminId,"PROFINO read-only deposit schema audit\n"+JSON.stringify(audit));
  return true;
 } catch(error) {
  try { logCode(safeDiagnosticCode(error)); } catch {}
  return false;
 }
}
