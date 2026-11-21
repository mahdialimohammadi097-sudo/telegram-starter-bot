// Operator-only, read-only readiness report. Never auto-runs in the bot.
// DATABASE_URL must be a deliberately supplied least-privilege read-only DSN.
import pg from "pg";
import {auditDepositSchema} from "../src/deposit-schema-audit.js";
if(!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,
  connectionTimeoutMillis:10000,
  options:"-c default_transaction_read_only=on -c statement_timeout=10000"});
try{
 const client=await pool.connect();
 try{
  await client.query("BEGIN READ ONLY");
  const result=await auditDepositSchema(client);
  await client.query("COMMIT");
  process.stdout.write(JSON.stringify({audit:"deposit-schema",...result})+"\n");
  if(!result.ready) process.exitCode=2;
 }catch(error){
  await client.query("ROLLBACK").catch(()=>{});
  throw error;
 }finally{client.release()}
}catch(error){
 // Do not echo driver errors: they may contain hostnames, SQL or connection details.
 process.stderr.write(JSON.stringify({audit:"deposit-schema",ready:false,
  error:"Audit execution failed; inspect private server logs without sharing secrets",
  code:typeof error?.code==="string" && /^[A-Z0-9]{2,8}$/.test(error.code) ? error.code : "AUDIT_ERROR"})+"\\n");
 process.exitCode=3;
}finally{await pool.end()}
