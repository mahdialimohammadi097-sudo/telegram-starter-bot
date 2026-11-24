// Operator-only, read-only readiness report. Never auto-runs in the bot.
// DATABASE_URL must be a deliberately supplied least-privilege read-only DSN.
import pg from "pg";
import {runReadOnlyDepositAudit} from "../src/read-only-deposit-audit.js";
import {resolveDatabaseTls} from "../src/database-tls-policy.js";
import {safeDiagnosticCode} from "../src/diagnostic-safety.js";

let pool;
try {
 if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
 pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,
   connectionTimeoutMillis:10000,ssl:resolveDatabaseTls(),
   options:"-c default_transaction_read_only=on -c statement_timeout=10000"});
 const result=await runReadOnlyDepositAudit(pool);
 process.stdout.write(JSON.stringify({audit:"deposit-schema",...result})+"\n");
 if(!result.ready) process.exitCode=2;
} catch(error) {
 process.stderr.write(JSON.stringify({audit:"deposit-schema",ready:false,
   error:"Audit execution failed; inspect private server logs without sharing secrets",
   code:safeDiagnosticCode(error)})+"\n");
 process.exitCode=3;
} finally {
 if (pool) {
   try { await pool.end(); }
   catch { process.stderr.write("Audit connection cleanup failed.\n"); process.exitCode=3; }
 }
}
