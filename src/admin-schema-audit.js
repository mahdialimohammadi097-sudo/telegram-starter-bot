// Read-only, one-shot structural diagnostic for the existing production database.
// No user rows, wallet addresses, balances or secrets are queried or returned.
export async function inspectDepositSchemaReadOnly(pool) {
 const required={
  verified_deposit_evidence:["event_key","block_hash","block_number","token_contract","deposit_address","amount_base_units"],
  wallets:["id","wallet_address","chain_id","is_platform_controlled"],
  ledger_accounts:["id","user_id","account_type","currency"],
  ledger_transactions:["id","idempotency_key","status","transaction_type","reference_id"],
  ledger_entries:["transaction_id","account_id","entry_type","amount","currency"],
  user_wallet_assignments:["id","user_id","wallet_id","assignment_type","status","ended_at"],
  deposit_address_ownership_history:["id","wallet_id","user_id","chain_id","wallet_address","start_block","end_block","recorded_at","verified_source"]
 };
 const client=await pool.connect();
 try {
  await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
  await client.query("SET LOCAL statement_timeout = '5000ms'");
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
   "wallets.chain_id":"bigint",
   "user_wallet_assignments.user_id":"bigint",
   "user_wallet_assignments.wallet_id":"bigint"
  };
  const observedTypes=Object.fromEntries(result.rows
   .filter(r=>Object.hasOwn(expectedTypes,r.table_name+"."+r.column_name))
   .map(r=>[r.table_name+"."+r.column_name,r.data_type??"unknown"]));
  const incompatibleTypes=Object.entries(expectedTypes).filter(([key,type])=>
   observedTypes[key]!==type).map(([key,type])=>({
    column:key,expected:type,observed:observedTypes[key]??"missing"
   }));
  const indexes=await client.query(`SELECT t.relname AS table_name,a.attname AS column_name
   FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
   JOIN pg_namespace n ON n.oid=t.relnamespace
   JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
   WHERE n.nspname='public' AND i.indisunique AND i.indisvalid AND i.indisready
    AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=1
    AND ((t.relname='verified_deposit_evidence' AND a.attname='event_key')
      OR (t.relname='ledger_transactions' AND a.attname='idempotency_key'))`);
  const uniqueKeys=new Set(indexes.rows.map(r=>r.table_name+"."+r.column_name));
  for(const key of ["verified_deposit_evidence.event_key","ledger_transactions.idempotency_key"])
   if(!uniqueKeys.has(key))missing.push("unique:"+key);
  await client.query("ROLLBACK");
  return {audit:"deposit-schema",structuralReady:missing.length===0,missing,\n   migrationTypeCompatible:incompatibleTypes.length===0,incompatibleTypes,
   financialActivationReady:false,realDepositsEnabled:false,
   outstandingSecurityGates:["independent-historical-ownership-proof","independent-chain-finality-verification","production-backup-restore","owner-financial-authorization"]};
 } catch(error) {
  await client.query("ROLLBACK").catch(()=>{});
  throw error;
 } finally {client.release();}
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
  const code=typeof error?.code==="string" && /^[A-Z0-9]{2,8}$/.test(error.code)
   ? error.code : "UNKNOWN";
  logCode(code);
  return false;
 }
}
