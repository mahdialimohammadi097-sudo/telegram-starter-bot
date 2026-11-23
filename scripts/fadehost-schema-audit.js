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
   // Consistent catalog/data snapshot; bounded lock wait for production safety.
   await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
   await client.query("SET LOCAL lock_timeout = '2000ms'");
   const {rows}=await client.query(`SELECT table_name,column_name,is_nullable,data_type,numeric_precision,numeric_scale
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=ANY($1::text[])`,[Object.keys(required)]);
   const columns=new Set(rows.map(x=>x.table_name+"."+x.column_name));
   const missing=Object.entries(required).flatMap(([t,cols])=>
    cols.filter(c=>!columns.has(t+"."+c)).map(c=>t+"."+c));
   // Fail closed if ledger amounts cannot represent the exact 8-decimal USDT units.
   const amountColumn=rows.find(x=>x.table_name==="ledger_entries" && x.column_name==="amount");
   if(amountColumn && (amountColumn.data_type!=="numeric" ||
      Number(amountColumn.numeric_precision)!==36 || Number(amountColumn.numeric_scale)!==18))
    missing.push("type:ledger_entries.amount:numeric(36,18)");
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
   // Financial posting must not silently accept orphaned or nullable journal entries.
   for(const key of [
    "ledger_entries.transaction_id",
    "ledger_entries.account_id",
    "ledger_entries.entry_type",
    "ledger_entries.amount",
    "ledger_entries.currency",
    "ledger_transactions.idempotency_key"
   ]){
    const column=rows.find(x=>x.table_name+"."+x.column_name===key);
    if(column && column.is_nullable!=="NO")missing.push("not_null:"+key);
   }
   for(const key of [
    "deposit_address_ownership_history.wallet_id",
    "deposit_address_ownership_history.user_id",
    "deposit_address_ownership_history.chain_id",
    "deposit_address_ownership_history.wallet_address",
    "deposit_address_ownership_history.start_block"
   ]){
    const column=rows.find(x=>x.table_name+"."+x.column_name===key);
    if(column && column.is_nullable!=="NO")missing.push("not_null:"+key);
   }
   // Reject orphan-prone ledger schemas: posting rows must reference real
   // transactions and accounts through validated single-column foreign keys.
   const foreignKeys=await client.query(`SELECT tn.nspname AS target_schema, tt.relname AS target_table,
      a.attname AS source_column
     FROM pg_constraint c
     JOIN pg_class t ON t.oid=c.conrelid
     JOIN pg_namespace n ON n.oid=t.relnamespace
     JOIN pg_class tt ON tt.oid=c.confrelid
     JOIN pg_namespace tn ON tn.oid=tt.relnamespace
     JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=c.conkey[1]
     WHERE n.nspname='public' AND t.relname='ledger_entries'
       AND c.contype='f' AND array_length(c.conkey,1)=1
       AND array_length(c.confkey,1)=1 AND c.convalidated`);
   if(!foreignKeys || !Array.isArray(foreignKeys.rows))
    throw new Error("Malformed foreign-key catalog result");
   const references=new Set(foreignKeys.rows.map(x=>x.source_column+":"+x.target_schema+"."+x.target_table));
   for(const [column,target] of [
    ["transaction_id","ledger_transactions"],["account_id","ledger_accounts"]
   ]){
    if(!references.has(column+":public."+target))
     missing.push("foreign_key:ledger_entries."+column+"->"+target);
   }
   // Ledger integrity requires the database to reject zero/negative postings,
   // not merely application-side validators. Inspect validated CHECK constraints.
   const amountChecks=await client.query(`SELECT pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c
     JOIN pg_class t ON t.oid=c.conrelid
     JOIN pg_namespace n ON n.oid=t.relnamespace
     WHERE n.nspname='public' AND t.relname='ledger_entries'
       AND c.contype='c' AND c.convalidated`);
   if(!amountChecks || !Array.isArray(amountChecks.rows))
    throw new Error("Malformed ledger check-constraint catalog result");
   // CHECK expressions can contain OR branches, functions and casts. A regex
   // match on pg_get_constraintdef cannot prove positivity (e.g. OR TRUE).
   // Never certify a financial schema from unverified SQL text.
   if(!amountChecks.rows.some(row=>typeof row.definition==="string"))
    missing.push("check:ledger_entries.amount_positive");
   else missing.push("manual_review:ledger_entries.amount_positive_constraint");
   // Existing financial rows must also be consistent; a foreign key added
   // later does not excuse historical orphaned postings or nonpositive amounts.
   const ledgerColumns=["ledger_entries.transaction_id","ledger_entries.account_id",
    "ledger_entries.amount","ledger_transactions.id","ledger_accounts.id"];
   if(ledgerColumns.every(key=>columns.has(key))){
    const integrity=await client.query(`SELECT
     EXISTS(SELECT 1 FROM public.ledger_entries e
       LEFT JOIN public.ledger_transactions t ON t.id=e.transaction_id
       WHERE t.id IS NULL) AS orphan_transactions,
     EXISTS(SELECT 1 FROM public.ledger_entries e
       LEFT JOIN public.ledger_accounts a ON a.id=e.account_id
       WHERE a.id IS NULL) AS orphan_accounts,
     EXISTS(SELECT 1 FROM public.ledger_entries WHERE amount<=0 OR amount IS NULL)
       AS nonpositive_amounts`);
    const row=integrity?.rows?.[0];
    if(!row || typeof row.orphan_transactions!=="boolean" ||
       typeof row.orphan_accounts!=="boolean" ||
       typeof row.nonpositive_amounts!=="boolean")
     throw new Error("Malformed ledger integrity result");
    if(row.orphan_transactions)missing.push("data:ledger_entries.orphan_transactions");
    if(row.orphan_accounts)missing.push("data:ledger_entries.orphan_accounts");
    if(row.nonpositive_amounts)missing.push("data:ledger_entries.nonpositive_amounts");
   }
   // Financial invariant: every posted journal must balance exactly in each
   // currency, with only recognized debit/credit directions. Numeric sums are
   // computed by PostgreSQL without JavaScript floating-point conversion.
   if(["ledger_entries.transaction_id","ledger_entries.entry_type",
       "ledger_entries.amount","ledger_entries.currency"].every(k=>columns.has(k))){
    const unbalanced=await client.query(`SELECT EXISTS (
      SELECT 1 FROM public.ledger_entries
      GROUP BY transaction_id,currency
      HAVING COUNT(*) FILTER (WHERE entry_type='debit')=0
        OR COUNT(*) FILTER (WHERE entry_type='credit')=0
        OR COUNT(*) FILTER (WHERE entry_type IS NULL OR entry_type NOT IN ('debit','credit'))>0
        OR COUNT(*) FILTER (WHERE amount IS NULL OR amount<=0 OR currency IS NULL)>0
        OR SUM(CASE WHEN entry_type='debit' THEN amount ELSE 0 END)
          IS DISTINCT FROM SUM(CASE WHEN entry_type='credit' THEN amount ELSE 0 END)
    ) AS found`);
    if(typeof unbalanced?.rows?.[0]?.found!=="boolean")
     throw new Error("Malformed journal balance result");
    if(unbalanced.rows[0].found)
     missing.push("data:ledger_entries.unbalanced_journals");
    const invalidCurrency=await client.query(`SELECT EXISTS (
      SELECT 1 FROM public.ledger_entries WHERE currency IS NULL OR currency <> 'USDT'
    ) AS found`);
    if(typeof invalidCurrency?.rows?.[0]?.found!=="boolean")
     throw new Error("Malformed ledger currency result");
    if(invalidCurrency.rows[0].found)
     missing.push("data:ledger_entries.invalid_currency");
   }
   // Even an unused account with a foreign currency violates the USDT-only
   // financial schema policy. Inspect accounts separately from journal entries.
   if(columns.has("ledger_accounts.currency")){
    const invalidAccounts=await client.query(`SELECT EXISTS (
      SELECT 1 FROM public.ledger_accounts
      WHERE currency IS NULL OR currency <> 'USDT'
    ) AS found`);
    if(typeof invalidAccounts?.rows?.[0]?.found!=="boolean")
     throw new Error("Malformed ledger account currency inventory result");
    if(invalidAccounts.rows[0].found)
     missing.push("data:ledger_accounts.invalid_currency");
   }
   // Prevent cross-currency credits: every journal entry must use the
   // currency of its referenced account, not merely balance numerically.
   if(["ledger_entries.account_id","ledger_entries.currency",
       "ledger_accounts.id","ledger_accounts.currency"].every(k=>columns.has(k))){
    const mismatches=await client.query(`SELECT EXISTS (
      SELECT 1 FROM public.ledger_entries e
      JOIN public.ledger_accounts a ON a.id=e.account_id
      WHERE e.currency IS DISTINCT FROM a.currency
    ) AS found`);
    if(typeof mismatches?.rows?.[0]?.found!=="boolean")
     throw new Error("Malformed ledger account currency result");
    if(mismatches.rows[0].found)
     missing.push("data:ledger_entries.account_currency_mismatch");
   }
   // Event identity and ledger idempotency must be unique in existing data,
   // independently of catalog constraints (which may have been added later).
   if(columns.has("verified_deposit_evidence.event_key")){
    const duplicates=await client.query(`SELECT EXISTS (
      SELECT 1 FROM public.verified_deposit_evidence
      GROUP BY event_key HAVING COUNT(*)>1
    ) AS found`);
    if(typeof duplicates?.rows?.[0]?.found!=="boolean")
     throw new Error("Malformed deposit evidence duplicate result");
    if(duplicates.rows[0].found)missing.push("data:verified_deposit_evidence.duplicate_event_key");
   }
   if(columns.has("ledger_transactions.idempotency_key")){
    const duplicates=await client.query(`SELECT EXISTS (
      SELECT 1 FROM public.ledger_transactions
      GROUP BY idempotency_key HAVING COUNT(*)>1
    ) AS found`);
    if(typeof duplicates?.rows?.[0]?.found!=="boolean")
     throw new Error("Malformed ledger idempotency duplicate result");
    if(duplicates.rows[0].found)missing.push("data:ledger_transactions.duplicate_idempotency_key");
   }
   // A ledger transaction must never exist with a duplicated event identity
   // or an incomplete journal. Inspect existing rows without any mutations.
   if(["ledger_transactions.id","ledger_entries.transaction_id"].every(k=>columns.has(k))){
    const emptyJournals=await client.query(`SELECT EXISTS (
      SELECT 1 FROM public.ledger_transactions t
      WHERE NOT EXISTS (
       SELECT 1 FROM public.ledger_entries e WHERE e.transaction_id=t.id
      )
    ) AS found`);
    if(typeof emptyJournals?.rows?.[0]?.found!=="boolean")
     throw new Error("Malformed empty journal inspection result");
    if(emptyJournals.rows[0].found)
     missing.push("data:ledger_transactions.without_entries");
   }
   // An active wallet must not be assigned to multiple users at once.
   // This is an additional read-only safeguard; historical block ownership
   // remains authoritative for attribution of older deposits.
   if(["user_wallet_assignments.wallet_id","user_wallet_assignments.user_id",
       "user_wallet_assignments.status","user_wallet_assignments.ended_at"].every(k=>columns.has(k))){
    const ambiguous=await client.query(`SELECT EXISTS (
      SELECT 1 FROM public.user_wallet_assignments
      WHERE status='active' AND ended_at IS NULL
      GROUP BY wallet_id HAVING COUNT(DISTINCT user_id)>1
    ) AS found`);
    if(typeof ambiguous?.rows?.[0]?.found!=="boolean")
     throw new Error("Malformed active wallet ownership result");
    if(ambiguous.rows[0].found)
     missing.push("data:user_wallet_assignments.multiple_active_owners");
   }
   // Two active assignments to the same wallet are ambiguous even when
   // both happen to reference the same user: fail closed for deposit routing.
   if(["user_wallet_assignments.wallet_id","user_wallet_assignments.status",
       "user_wallet_assignments.ended_at"].every(k=>columns.has(k))){
    const duplicates=await client.query(`SELECT EXISTS (
      SELECT 1 FROM public.user_wallet_assignments
      WHERE status='active' AND ended_at IS NULL
      GROUP BY wallet_id HAVING COUNT(*)>1
    ) AS found`);
    if(typeof duplicates?.rows?.[0]?.found!=="boolean")
     throw new Error("Malformed active wallet assignment duplicate result");
    if(duplicates.rows[0].found)
     missing.push("data:user_wallet_assignments.duplicate_active_wallet");
   }
   // Wallet assignments must point to existing users and wallets.
   // Catalog foreign keys alone cannot prove legacy data was clean.
   if(["user_wallet_assignments.user_id","user_wallet_assignments.wallet_id",
       "users.id","wallets.id"].every(k=>columns.has(k))){
    const orphanAssignments=await client.query(`SELECT
      EXISTS(SELECT 1 FROM public.user_wallet_assignments a
       LEFT JOIN public.users u ON u.id=a.user_id
       WHERE u.id IS NULL) AS missing_user,
      EXISTS(SELECT 1 FROM public.user_wallet_assignments a
       LEFT JOIN public.wallets w ON w.id=a.wallet_id
       WHERE w.id IS NULL) AS missing_wallet`);
    const row=orphanAssignments?.rows?.[0];
    if(typeof row?.missing_user!=="boolean" || typeof row?.missing_wallet!=="boolean")
     throw new Error("Malformed wallet assignment reference result");
    if(row.missing_user)missing.push("data:user_wallet_assignments.orphan_user");
    if(row.missing_wallet)missing.push("data:user_wallet_assignments.orphan_wallet");
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
    const invalid=await client.query(`SELECT EXISTS (
      SELECT 1 FROM public.deposit_address_ownership_history
      WHERE start_block < 0 OR (end_block IS NOT NULL AND end_block<=start_block)
    ) AS found`);
    if(invalid.rows?.[0]?.found!==false)
     missing.push("invalid_interval:deposit_address_ownership_history");
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
