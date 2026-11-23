// One-shot, read-only operator diagnostic for the EXISTING production bot.
// Never starts Telegram, alters schema, or processes money.
import pg from "pg";
const required = {
 users:["id","status"],
 wallets:["id","wallet_address","chain_id","network","status","wallet_type","is_platform_controlled"],
 user_wallet_assignments:["id","user_id","wallet_id","assignment_type","status","ended_at"],
 ledger_accounts:["id","user_id","account_type","currency"],
 ledger_transactions:["id","idempotency_key","status","transaction_type","reference_id"],
 ledger_entries:["transaction_id","account_id","entry_type","amount","currency"],
 verified_deposit_evidence:["event_key","block_hash","block_number","token_contract","deposit_address","amount_base_units"],
 deposit_address_ownership_history:["wallet_id","user_id","chain_id","wallet_address","start_block","end_block"]
};
const output = value => process.stdout.write(JSON.stringify(value)+"\n");
if (!process.env.DATABASE_URL) {
 output({audit:"fadehost-schema",ready:false,error:"DATABASE_URL_NOT_CONFIGURED"});
 process.exitCode=3;
} else {
 const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,
  connectionTimeoutMillis:8000,options:"-c default_transaction_read_only=on -c statement_timeout=8000"});
 try {
  const client=await pool.connect();
  try {
   await client.query("BEGIN READ ONLY");
   const {rows}=await client.query(`SELECT table_name,column_name,is_nullable
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
   // PostgreSQL UNIQUE permits multiple NULL values; identity keys must also be NOT NULL.
   for(const key of ["verified_deposit_evidence.event_key","ledger_transactions.idempotency_key"]){
    const column=rows.find(x=>x.table_name+"."+x.column_name===key);
    if(column && column.is_nullable!=="NO")missing.push("not_null:"+key);
   }
   // Read-only snapshot check: overlapping historical ownership can credit the
   // wrong user even when event identity uniqueness is enforced elsewhere.
   const historyColumns=required.deposit_address_ownership_history.every(c=>
    columns.has("deposit_address_ownership_history."+c));
   if(historyColumns){
    const overlap=await client.query(`SELECT EXISTS (
      SELECT 1 FROM public.deposit_address_ownership_history a
      JOIN public.deposit_address_ownership_history b
        ON a.chain_id=b.chain_id AND a.wallet_address=b.wallet_address
       AND a.ctid<b.ctid
       AND (a.end_block IS NULL OR b.start_block<a.end_block)
       AND (b.end_block IS NULL OR a.start_block<b.end_block)
    ) AS found`);
    if(overlap.rows?.[0]?.found!==false)
     missing.push("overlap:deposit_address_ownership_history");
   }
   await client.query("COMMIT");
   output({audit:"fadehost-schema",ready:missing.length===0,missing});
   if(missing.length)process.exitCode=2;
  } catch(e) {await client.query("ROLLBACK").catch(()=>{});throw e}
  finally {client.release()}
 } catch(e) {
  output({audit:"fadehost-schema",ready:false,error:"READ_ONLY_AUDIT_FAILED",
   code:typeof e?.code==="string"&&/^[A-Z0-9]{2,8}$/.test(e.code)?e.code:"UNKNOWN"});
  process.exitCode=3;
 } finally {await pool.end()}
}
