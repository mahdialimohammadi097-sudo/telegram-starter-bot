// One-shot, read-only operator diagnostic for the EXISTING production bot.
// Never starts Telegram, alters schema, or processes money.
import pg from "pg";
import { resolveDatabaseTls } from "../src/database-tls-policy.js";
import { rollbackTransaction } from "../src/transaction-safety.js";
import { safeDiagnosticCode } from "../src/diagnostic-safety.js";
const required = {
 users:["id","status"],
 wallets:["id","wallet_address","chain_id","network","status","wallet_type","is_platform_controlled"],
 user_wallet_assignments:["id","user_id","wallet_id","assignment_type","status","ended_at"],
 ledger_accounts:["id","user_id","account_type","currency"],
 ledger_transactions:["id","idempotency_key","status","transaction_type","reference_id"],
 ledger_entries:["transaction_id","account_id","entry_type","amount","currency"],
 verified_deposit_evidence:["event_key","block_hash","block_number","token_contract","deposit_address","amount_base_units"]
};
let report;
const output = value => { report = value; };
if (!process.env.DATABASE_URL) {
 output({audit:"fadehost-schema",ready:false,error:"DATABASE_URL_NOT_CONFIGURED"});
 process.exitCode=3;
} else {
 let pool;
 try {
  pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,
   ssl:resolveDatabaseTls(),connectionTimeoutMillis:8000,
   options:"-c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=3000"});
  const client=await pool.connect();
  let discard;
  try {
   await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
   const {rows}=await client.query(`SELECT table_name,column_name
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=ANY($1::text[])`,[Object.keys(required)]);
   const columns=new Set(rows.map(x=>x.table_name+"."+x.column_name));
   const missing=Object.entries(required).flatMap(([t,cols])=>
    cols.filter(c=>!columns.has(t+"."+c)).map(c=>t+"."+c));
   const indexes=await client.query(`SELECT t.relname AS table_name,a.attname AS column_name
     FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
     JOIN pg_namespace n ON n.oid=t.relnamespace
     JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
     WHERE n.nspname='public' AND i.indisunique AND i.indisvalid AND i.indisready
       AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=1
       AND ((t.relname='verified_deposit_evidence' AND a.attname='event_key')
        OR (t.relname='ledger_transactions' AND a.attname='idempotency_key'))`);
   const keys=new Set(indexes.rows.map(x=>x.table_name+"."+x.column_name));
   for(const key of ["verified_deposit_evidence.event_key","ledger_transactions.idempotency_key"])
    if(!keys.has(key))missing.push("unique:"+key);
   await client.query("COMMIT");
   output({audit:"fadehost-schema",ready:missing.length===0,missing});
   if(missing.length)process.exitCode=2;
  } catch(e) {discard=await rollbackTransaction(client,e);throw e}
  finally {client.release(discard || undefined)}
 } catch(e) {
  output({audit:"fadehost-schema",ready:false,error:"READ_ONLY_AUDIT_FAILED",
   code:safeDiagnosticCode(e)});
  process.exitCode=3;
 } finally {
  if (pool) {
   try { await pool.end(); }
   catch { output({audit:"fadehost-schema",ready:false,error:"AUDIT_CLEANUP_FAILED"});process.exitCode=3; }
  }
 }
}

// Emit exactly one report, including any cleanup failure.
process.stdout.write(JSON.stringify(report)+"\n");
