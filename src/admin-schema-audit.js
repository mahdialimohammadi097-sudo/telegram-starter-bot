// Read-only, one-shot structural diagnostic for the existing production database.
// No user rows, wallet addresses, balances or secrets are queried or returned.
export async function inspectDepositSchemaReadOnly(pool) {
 const required={
  verified_deposit_evidence:["event_key","block_hash","block_number","token_contract","deposit_address","amount_base_units"],
  wallets:["id","wallet_address","chain_id","is_platform_controlled"],
  user_wallet_assignments:["id","user_id","wallet_id","assignment_type","status","ended_at"]
 };
 const client=await pool.connect();
 try {
  await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
  await client.query("SET LOCAL statement_timeout = '5000ms'");
  const result=await client.query(`SELECT table_name,column_name FROM information_schema.columns
   WHERE table_schema='public' AND table_name=ANY($1::text[])`,[Object.keys(required)]);
  const present=new Set(result.rows.map(r=>r.table_name+"."+r.column_name));
  const missing=Object.entries(required).flatMap(([table,columns])=>
   columns.filter(column=>!present.has(table+"."+column)).map(column=>table+"."+column));
  const indexes=await client.query(`SELECT i.indisunique AS unique_key
   FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
   JOIN pg_namespace n ON n.oid=t.relnamespace
   JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
   WHERE n.nspname='public' AND t.relname='verified_deposit_evidence'
    AND a.attname='event_key' AND i.indisvalid AND i.indisready
    AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=1`);
  if(!indexes.rows.some(r=>r.unique_key===true))missing.push("unique:verified_deposit_evidence.event_key");
  await client.query("ROLLBACK");
  return {audit:"deposit-schema",structuralReady:missing.length===0,missing,
   financialActivationReady:false,realDepositsEnabled:false};
 } catch(error) {
  await client.query("ROLLBACK").catch(()=>{});
  throw error;
 } finally {client.release();}
}
