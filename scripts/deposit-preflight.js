// Operator-triggered, read-only deposit preflight. No bot handlers or production writes.
import pg from "pg";
import {auditDepositSchema} from "../src/deposit-schema-audit.js";

export async function inspectDepositAssignments(client) {
 const duplicates=await client.query(`
 SELECT COUNT(*)::integer AS groups
 FROM (
   SELECT wallet_id FROM public.user_wallet_assignments
   WHERE status='active' AND assignment_type='deposit'
   GROUP BY wallet_id HAVING COUNT(DISTINCT user_id)>1
 ) d`);
 const indexes=await client.query(`
 SELECT i.indisunique,i.indisvalid,i.indisready,
        pg_get_indexdef(i.indexrelid) AS definition
 FROM pg_index i
 JOIN pg_class t ON t.oid=i.indrelid
 JOIN pg_namespace n ON n.oid=t.relnamespace
 WHERE n.nspname='public' AND t.relname='user_wallet_assignments'`);
 const defs=indexes.rows.filter(r=>r.indisunique===true&&r.indisvalid===true&&r.indisready===true)
   .map(r=>String(r.definition).toLowerCase().replace(/\s+/g," "));
 // Only recognize the narrow known safe index shape. Other shapes require review.
 const walletUnique=defs.some(d=>/\(wallet_id\) where/.test(d)&&
   /status/.test(d)&&/active/.test(d)&&/assignment_type/.test(d)&&/deposit/.test(d));
 return Object.freeze({
  conflictingActiveDepositWallets:Number(duplicates.rows[0]?.groups??0),
  activeDepositWalletUniquenessEnforced:walletUnique
 });
}

export async function runReadOnlyPreflight(client) {
 await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
 try {
  const schema=await auditDepositSchema(client);
  const assignments=await inspectDepositAssignments(client);
  await client.query("ROLLBACK");
  return Object.freeze({audit:"deposit-preflight",ready:schema.ready&&
   assignments.conflictingActiveDepositWallets===0&&assignments.activeDepositWalletUniquenessEnforced,
   schema,assignments,realDepositsEnabled:false});
 } catch(error) {
  await client.query("ROLLBACK").catch(()=>{});
  throw error;
 }
}

if(process.argv[1] && import.meta.url===new URL("file://"+process.argv[1]).href) {
 const url=process.env.PROFINO_AUDIT_DATABASE_URL;
 if(!url) {
  process.stderr.write('{"audit":"deposit-preflight","ready":false,"error":"Read-only audit connection required"}\\n');
  process.exitCode=3;
 } else {
  const pool=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:10000,
   options:"-c default_transaction_read_only=on -c statement_timeout=10000"});
  try {
   const client=await pool.connect();
   try {
    const report=await runReadOnlyPreflight(client);
    process.stdout.write(JSON.stringify(report)+"\\n");
    if(!report.ready) process.exitCode=2;
   } finally {client.release();}
  } catch(error) {
   process.stderr.write(JSON.stringify({audit:"deposit-preflight",ready:false,
    error:"Read-only preflight failed",code:/^[A-Z0-9]{2,8}$/.test(error?.code??"")?error.code:"AUDIT_ERROR"})+"\\n");
   process.exitCode=3;
  } finally {await pool.end();}
 }
}
