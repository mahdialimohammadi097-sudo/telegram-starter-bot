// Read-only prerequisite check. Fail closed if production catalog differs from
// the reviewed contract. This does not create or alter tables.
const required={
 users:["id","status"],
 wallets:["id","wallet_address","chain_id","network","status","wallet_type","is_platform_controlled"],
 user_wallet_assignments:["id","user_id","wallet_id","assignment_type","status","ended_at"],
 ledger_accounts:["id","user_id","account_type","currency"],
 ledger_transactions:["id","idempotency_key","status","transaction_type","reference_id"],
 ledger_entries:["transaction_id","account_id","entry_type","amount","currency"],
 verified_deposit_evidence:["event_key","block_hash","block_number","token_contract","deposit_address","amount_base_units"]
};
export async function auditDepositSchema(client,{schema="public"}={}) {
 if(!client || typeof client.query!=="function" || typeof schema!=="string" || !/^[a-z_][a-z_0-9]{0,62}$/.test(schema))
  throw new TypeError("Invalid schema audit configuration");
 const result=await client.query(`
 SELECT col.table_name,col.column_name,col.data_type,col.numeric_precision,col.numeric_scale,col.is_nullable
 FROM information_schema.columns col
 WHERE col.table_schema=$1 AND col.table_name=ANY($2::text[])
 AND EXISTS (
   SELECT 1 FROM pg_catalog.pg_class relation
   JOIN pg_catalog.pg_namespace ns ON ns.oid=relation.relnamespace
   WHERE ns.nspname=col.table_schema AND relation.relname=col.table_name
     AND relation.relkind='r' AND relation.relpersistence='p'
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_inherits inheritance
       WHERE inheritance.inhparent=relation.oid OR inheritance.inhrelid=relation.oid
     )
 )`,[schema,Object.keys(required)]);
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
 for(const name of [
  'users.id',
  'wallets.id',
  'wallets.wallet_address',
  'wallets.chain_id',
  'wallets.network',
  'wallets.status',
  'wallets.wallet_type',
  'wallets.is_platform_controlled',
  'user_wallet_assignments.id',
  'user_wallet_assignments.user_id',
  'user_wallet_assignments.wallet_id',
  'user_wallet_assignments.assignment_type',
  'user_wallet_assignments.status',
  'verified_deposit_evidence.event_key',
  'verified_deposit_evidence.block_hash',
  'verified_deposit_evidence.block_number',
  'verified_deposit_evidence.token_contract',
  'verified_deposit_evidence.deposit_address',
  'verified_deposit_evidence.amount_base_units',
  'ledger_transactions.idempotency_key',
  'ledger_entries.amount',
  'ledger_entries.transaction_id',
  'ledger_entries.account_id'
 ]) {
  const col=types.get(name);
  if(col && col.is_nullable!=='NO') incompatible.push(name+':not_null');
 }
 const numericContract={
  "ledger_entries.amount":{precision:36,scale:18}
 };
 for(const [name,expected] of Object.entries({
   "wallets.is_platform_controlled":"boolean",
   "ledger_entries.amount":"numeric",
   "verified_deposit_evidence.event_key":"text",
   "ledger_transactions.idempotency_key":"text",
   "verified_deposit_evidence.amount_base_units":"numeric",
   "verified_deposit_evidence.block_number":"numeric"
 })) {
   const col=types.get(name);
   if(col && (col.data_type!==expected ||
     (numericContract[name] && (
       Number(col.numeric_scale)!==numericContract[name].scale ||
       Number(col.numeric_precision)<numericContract[name].precision ||
       col.numeric_precision==null)) ||
     (name.startsWith("verified_deposit_evidence.") && expected==="numeric" &&
       (col.numeric_precision!==null || col.numeric_scale!==null))))
     incompatible.push(name);
 }
 // A unique index on the event key and the ledger idempotency key is mandatory.
 const unique=await client.query(`
 SELECT t.relname AS tablename,a.attname AS column_name,
        i.indisvalid AS valid,i.indisready AS ready,i.indimmediate AS immediate,
        i.indpred IS NULL AS unfiltered,
        i.indexprs IS NULL AS plain_column,
        i.indnkeyatts AS key_count
 FROM pg_index i
 JOIN pg_class t ON t.oid=i.indrelid
 JOIN pg_namespace n ON n.oid=t.relnamespace
 JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
 WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) AND i.indisunique AND i.indislive AND NOT i.indisexclusion
 `,[schema,["verified_deposit_evidence","ledger_transactions"]]);
 const uniqueIndex=(table,column)=>unique.rows.some(r=>
   r.tablename===table && r.column_name===column &&
   r.valid===true && r.ready===true && r.immediate===true && r.unfiltered===true &&
   r.plain_column===true && Number(r.key_count)===1);
 for(const [table,column] of [["verified_deposit_evidence","event_key"],
   ["ledger_transactions","idempotency_key"]])
   if(!uniqueIndex(table,column)) incompatible.push(table+"."+column+":unique_index");
 // Inspect actual FK constraints rather than inferring relationships from names.
 const foreignKeys=await client.query(`
 SELECT c.convalidated AS validated, source.relname AS source_table, source_col.attname AS source_column,
        target.relname AS target_table, target_col.attname AS target_column
 FROM pg_constraint c
 JOIN pg_class source ON source.oid=c.conrelid
 JOIN pg_namespace ns ON ns.oid=source.relnamespace
 JOIN pg_class target ON target.oid=c.confrelid
 JOIN pg_namespace target_ns ON target_ns.oid=target.relnamespace
 JOIN LATERAL unnest(c.conkey,c.confkey) AS pair(source_attnum,target_attnum) ON true
 JOIN pg_attribute source_col ON source_col.attrelid=source.oid AND source_col.attnum=pair.source_attnum
 JOIN pg_attribute target_col ON target_col.attrelid=target.oid AND target_col.attnum=pair.target_attnum
 WHERE c.contype='f' AND ns.nspname=$1 AND target_ns.nspname=$1
   AND cardinality(c.conkey)=1 AND cardinality(c.confkey)=1`,[schema]);
 const fkSet=new Set(foreignKeys.rows.filter(r=>r.validated===true).map(r=>[r.source_table,r.source_column,r.target_table,r.target_column].join('.')));
 for(const relation of [
  ["user_wallet_assignments","user_id","users","id"],
  ["user_wallet_assignments","wallet_id","wallets","id"],
  ["ledger_accounts","user_id","users","id"],
  ["ledger_entries","transaction_id","ledger_transactions","id"],
  ["ledger_entries","account_id","ledger_accounts","id"]
 ]) if(!fkSet.has(relation.join('.'))) incompatible.push(relation.slice(0,2).join('.')+":foreign_key");
 // An existing evidence table can have all expected columns but lack the
 // CHECK constraints required to reject malformed chain events and addresses.
 // CREATE TABLE IF NOT EXISTS does not repair such a table.
 const checks=await client.query(`
 SELECT c.conname,c.convalidated AS validated,
        pg_catalog.pg_get_expr(c.conbin,c.conrelid,false) AS expression
 FROM pg_constraint c
 JOIN pg_class t ON t.oid=c.conrelid
 JOIN pg_namespace n ON n.oid=t.relnamespace
 WHERE n.nspname=$1 AND t.relname='verified_deposit_evidence' AND c.contype='c'
 `,[schema]);
 // Require the reviewed PostgreSQL expression, not merely a trusted-looking name.
 // Semantically equivalent but differently rendered constraints need manual review.
 const expectedChecks={
  verified_deposit_evidence_event_key_format:"(event_key ~ '^bsc:56:0x[0-9a-f]{64}:(0|[1-9][0-9]{0,77}))",
  verified_deposit_evidence_block_hash_format:"(block_hash ~ '^0x[0-9a-f]{64}$'::text)",
  verified_deposit_evidence_token_format:"(token_contract ~ '^0x[0-9a-f]{40}$'::text)",
  verified_deposit_evidence_address_format:"(deposit_address ~ '^0x[0-9a-f]{40}$'::text)",
  verified_deposit_evidence_token_nonzero:"(token_contract <> '0x0000000000000000000000000000000000000000'::text)",
  verified_deposit_evidence_address_nonzero:"(deposit_address <> '0x0000000000000000000000000000000000000000'::text)",
  verified_deposit_evidence_log_index_uint256:"CASE WHEN (split_part(event_key, ':'::text, 4) ~ '^(0|[1-9][0-9]{0,77})$'::text) THEN ((split_part(event_key, ':'::text, 4))::numeric <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric) ELSE false END"
 };
 for(const [name,expression] of Object.entries(expectedChecks)) {
  const matching=checks.rows.filter(r=>r.conname===name);
  if(matching.length!==1 || matching[0].validated!==true || typeof matching[0].expression!=="string" || matching[0].expression.replace(/\s+/g," ").trim()!==expression)
   incompatible.push("verified_deposit_evidence."+name+":check_constraint");
 }
 // Named or unnamed numeric checks must have the exact reviewed expression.
 // Unconstrained numeric preserves input scale; typmods round before CHECK.
 // Numeric can represent NaN and values outside uint256.
 // A finite upper bound excludes both; positive-only CHECK does not.
 const numericChecks={
  block_number_integer:"(scale(block_number) = 0)",
  amount_integer:"(scale(amount_base_units) = 0)",
  block_number_nonnegative:"(block_number >= (0)::numeric)",
  amount_positive:"(amount_base_units > (0)::numeric)",
  block_number_uint256:"(block_number <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric)",
  amount_uint256:"(amount_base_units <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric)"
 };
 for(const [name,expression] of Object.entries(numericChecks)) {
  if(!checks.rows.some(r=>r.validated===true && r.expression===expression))
   incompatible.push("verified_deposit_evidence."+name+":check_constraint");
 }
 // Check the exact reviewed statement-level mutation guard, not its name alone.
 // This is catalog evidence only: privileged owners and role grants still need review.
 const guardBody="\nBEGIN\n RAISE EXCEPTION 'Verified deposit evidence is immutable' USING ERRCODE='55000';\nEND\n";
 const guards=await client.query(`
 SELECT tg.tgname,
        (tg.tgenabled='A' AND tg.tgtype=58 AND tg.tgconstraint=0
         AND tg.tgqual IS NULL AND tg.tgnargs=0 AND tg.tgattr::text=''
         AND p.proname='reject_verified_deposit_evidence_mutation'
         AND fn.nspname=$1 AND p.prokind='f' AND p.pronargs=0
         AND p.prorettype='pg_catalog.trigger'::pg_catalog.regtype
         AND lang.lanname='plpgsql' AND NOT p.prosecdef
         AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
         AND p.prosrc=$2) AS reviewed_guard,
        NOT EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(COALESCE(t.relacl,pg_catalog.acldefault('r',t.relowner))) acl
          WHERE acl.grantee=0
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute col
          CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) acl
          WHERE col.attrelid=t.oid AND col.attnum>0 AND NOT col.attisdropped
            AND acl.grantee=0
        ) AS no_public_table_access,
        NOT EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
          WHERE acl.grantee=0
        ) AS no_public_function_access,
        NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_rewrite rule
          WHERE rule.ev_class=t.oid
        ) AS no_rewrite_rules
 FROM pg_catalog.pg_trigger tg
 JOIN pg_catalog.pg_class t ON t.oid=tg.tgrelid
 JOIN pg_catalog.pg_namespace ns ON ns.oid=t.relnamespace
 JOIN pg_catalog.pg_proc p ON p.oid=tg.tgfoid
 JOIN pg_catalog.pg_namespace fn ON fn.oid=p.pronamespace
 JOIN pg_catalog.pg_language lang ON lang.oid=p.prolang
 WHERE ns.nspname=$1 AND t.relname='verified_deposit_evidence' AND NOT tg.tgisinternal
 `,[schema,guardBody]);
 if(guards.rows.length!==1 || guards.rows[0].tgname!=="verified_deposit_evidence_immutable" ||
    guards.rows[0].reviewed_guard!==true || guards.rows[0].no_public_table_access!==true ||
    guards.rows[0].no_public_function_access!==true || guards.rows[0].no_rewrite_rules!==true)
   incompatible.push("verified_deposit_evidence:immutable_guard");
 return Object.freeze({ready:missing.length===0&&incompatible.length===0,
   missing:Object.freeze(missing),incompatible:Object.freeze(incompatible)});
}
::text)",
  verified_deposit_evidence_block_hash_format:"(block_hash ~ '^0x[0-9a-f]{64}$'::text)",
  verified_deposit_evidence_token_format:"(token_contract ~ '^0x[0-9a-f]{40}$'::text)",
  verified_deposit_evidence_address_format:"(deposit_address ~ '^0x[0-9a-f]{40}$'::text)"
 };
 for(const [name,expression] of Object.entries(expectedChecks)) {
  const matching=checks.rows.filter(r=>r.conname===name);
  if(matching.length!==1 || matching[0].validated!==true || matching[0].expression!==expression)
   incompatible.push("verified_deposit_evidence."+name+":check_constraint");
 }
 // Named or unnamed numeric checks must have the exact reviewed expression.
 // Unconstrained numeric preserves input scale; typmods round before CHECK.
 // Numeric can represent NaN and values outside uint256.
 // A finite upper bound excludes both; positive-only CHECK does not.
 const numericChecks={
  block_number_integer:"(scale(block_number) = 0)",
  amount_integer:"(scale(amount_base_units) = 0)",
  block_number_nonnegative:"(block_number >= (0)::numeric)",
  amount_positive:"(amount_base_units > (0)::numeric)",
  block_number_uint256:"(block_number <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric)",
  amount_uint256:"(amount_base_units <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'::numeric)"
 };
 for(const [name,expression] of Object.entries(numericChecks)) {
  if(!checks.rows.some(r=>r.validated===true && r.expression===expression))
   incompatible.push("verified_deposit_evidence."+name+":check_constraint");
 }
 // Check the exact reviewed statement-level mutation guard, not its name alone.
 // This is catalog evidence only: privileged owners and role grants still need review.
 const guardBody="\nBEGIN\n RAISE EXCEPTION 'Verified deposit evidence is immutable' USING ERRCODE='55000';\nEND\n";
 const guards=await client.query(`
 SELECT tg.tgname,
        (tg.tgenabled='A' AND tg.tgtype=58 AND tg.tgconstraint=0
         AND tg.tgqual IS NULL AND tg.tgnargs=0 AND tg.tgattr::text=''
         AND p.proname='reject_verified_deposit_evidence_mutation'
         AND fn.nspname=$1 AND p.prokind='f' AND p.pronargs=0
         AND p.prorettype='pg_catalog.trigger'::pg_catalog.regtype
         AND lang.lanname='plpgsql' AND NOT p.prosecdef
         AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
         AND p.prosrc=$2) AS reviewed_guard,
        NOT EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(COALESCE(t.relacl,pg_catalog.acldefault('r',t.relowner))) acl
          WHERE acl.grantee=0
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute col
          CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) acl
          WHERE col.attrelid=t.oid AND col.attnum>0 AND NOT col.attisdropped
            AND acl.grantee=0
        ) AS no_public_table_access,
        NOT EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
          WHERE acl.grantee=0
        ) AS no_public_function_access,
        NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_rewrite rule
          WHERE rule.ev_class=t.oid
        ) AS no_rewrite_rules
 FROM pg_catalog.pg_trigger tg
 JOIN pg_catalog.pg_class t ON t.oid=tg.tgrelid
 JOIN pg_catalog.pg_namespace ns ON ns.oid=t.relnamespace
 JOIN pg_catalog.pg_proc p ON p.oid=tg.tgfoid
 JOIN pg_catalog.pg_namespace fn ON fn.oid=p.pronamespace
 JOIN pg_catalog.pg_language lang ON lang.oid=p.prolang
 WHERE ns.nspname=$1 AND t.relname='verified_deposit_evidence' AND NOT tg.tgisinternal
 `,[schema,guardBody]);
 if(guards.rows.length!==1 || guards.rows[0].tgname!=="verified_deposit_evidence_immutable" ||
    guards.rows[0].reviewed_guard!==true || guards.rows[0].no_public_table_access!==true ||
    guards.rows[0].no_public_function_access!==true || guards.rows[0].no_rewrite_rules!==true)
   incompatible.push("verified_deposit_evidence:immutable_guard");
 return Object.freeze({ready:missing.length===0&&incompatible.length===0,
   missing:Object.freeze(missing),incompatible:Object.freeze(incompatible)});
}
