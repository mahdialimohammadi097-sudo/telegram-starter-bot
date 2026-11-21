// Read-only prerequisite check. Fail closed if production catalog differs from
// the reviewed contract. This does not create or alter tables.
const required={
 users:["id","status"],
 wallets:["id","wallet_address","chain_id","network","status"],
 user_wallet_assignments:["user_id","wallet_id","assignment_type","status"],
 ledger_accounts:["id","user_id","account_type","currency"],
 ledger_transactions:["id","idempotency_key","status","transaction_type","reference_id"],
 ledger_entries:["transaction_id","account_id","entry_type","amount","currency"],
 verified_deposit_evidence:["event_key","block_hash","block_number","token_contract","deposit_address","amount_base_units"]
};
export async function auditDepositSchema(client,{schema="public"}={}) {
 if(!client || typeof client.query!=="function" || !/^[a-z_][a-z_0-9]*$/.test(schema))
  throw new TypeError("Invalid schema audit configuration");
 const result=await client.query(`
 SELECT table_name,column_name,data_type,numeric_precision,numeric_scale FROM information_schema.columns
 WHERE table_schema=$1 AND table_name=ANY($2::text[])`,[schema,Object.keys(required)]);
 const actual=new Map();
 const types=new Map();
 for(const row of result.rows) {
  if(!actual.has(row.table_name))actual.set(row.table_name,new Set());
  actual.get(row.table_name).add(row.column_name);
  types.set(row.table_name+'.'+row.column_name,row);
 }
 const missing=[];
 for(const [table,columns] of Object.entries(required))
  for(const column of columns)
   if(!actual.get(table)?.has(column))missing.push(table+"."+column);
 const incompatible=[];
 for(const [name,expected] of Object.entries({
   "ledger_entries.amount":"numeric",
   "verified_deposit_evidence.event_key":"text",
   "ledger_transactions.idempotency_key":"text",
   "verified_deposit_evidence.amount_base_units":"numeric",
   "verified_deposit_evidence.block_number":"numeric"
 })) {
   const col=types.get(name);
   if(col && (col.data_type!==expected ||
     (col.numeric_scale!==undefined && col.numeric_scale!==null &&
      ["ledger_entries.amount","verified_deposit_evidence.amount_base_units","verified_deposit_evidence.block_number"].includes(name) &&
      Number(col.numeric_scale)!== (name==="ledger_entries.amount" ? 18 : 0))))
     incompatible.push(name);
 }
 // A unique index on the event key and the ledger idempotency key is mandatory.
 const unique=await client.query(`
 SELECT tablename,indexdef FROM pg_indexes
 WHERE schemaname=$1 AND tablename=ANY($2::text[])`,
 [schema,["verified_deposit_evidence","ledger_transactions"]]);
 const uniqueIndex=(table,column)=>unique.rows.some(r=>r.tablename===table &&
   /CREATE UNIQUE INDEX/i.test(r.indexdef) &&
   r.indexdef.includes('('+column+')'));
 for(const [table,column] of [["verified_deposit_evidence","event_key"],
   ["ledger_transactions","idempotency_key"]])
   if(!uniqueIndex(table,column)) incompatible.push(table+"."+column+":unique_index");
 // Inspect actual FK constraints rather than inferring relationships from names.
 const foreignKeys=await client.query(`
 SELECT source.relname AS source_table, source_col.attname AS source_column,
        target.relname AS target_table, target_col.attname AS target_column
 FROM pg_constraint c
 JOIN pg_class source ON source.oid=c.conrelid
 JOIN pg_namespace ns ON ns.oid=source.relnamespace
 JOIN pg_class target ON target.oid=c.confrelid
 JOIN pg_namespace target_ns ON target_ns.oid=target.relnamespace
 JOIN LATERAL unnest(c.conkey,c.confkey) AS pair(source_attnum,target_attnum) ON true
 JOIN pg_attribute source_col ON source_col.attrelid=source.oid AND source_col.attnum=pair.source_attnum
 JOIN pg_attribute target_col ON target_col.attrelid=target.oid AND target_col.attnum=pair.target_attnum
 WHERE c.contype='f' AND ns.nspname=$1 AND target_ns.nspname=$1`,[schema]);
 const fkSet=new Set(foreignKeys.rows.map(r=>[r.source_table,r.source_column,r.target_table,r.target_column].join('.')));
 for(const relation of [
  ["user_wallet_assignments","user_id","users","id"],
  ["user_wallet_assignments","wallet_id","wallets","id"],
  ["ledger_accounts","user_id","users","id"],
  ["ledger_entries","transaction_id","ledger_transactions","id"],
  ["ledger_entries","account_id","ledger_accounts","id"]
 ]) if(!fkSet.has(relation.join('.'))) incompatible.push(relation.slice(0,2).join('.')+":foreign_key");
 return Object.freeze({ready:missing.length===0&&incompatible.length===0,
   missing:Object.freeze(missing),incompatible:Object.freeze(incompatible)});
}
