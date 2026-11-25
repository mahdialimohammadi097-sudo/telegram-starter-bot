// Operator-only, read-only readiness report. Never auto-runs in the bot.
// DATABASE_URL must be a deliberately supplied least-privilege read-only DSN.
import pg from "pg";
import {runReadOnlyDepositAudit} from "../src/read-only-deposit-audit.js";
import {auditCombinedDepositPreflight} from "../src/legacy-deposit-assignment-audit.js";
import {resolveDatabaseTls} from "../src/database-tls-policy.js";
import {safeDiagnosticCode} from "../src/diagnostic-safety.js";

let pool;
let idleConnectionFailed=false;
let audit="deposit-schema";
try {
 const args=process.argv.slice(2);
 if(args.length===1 && args[0]==="--include-legacy-assignments") audit="combined-deposit-preflight";
 else if(args.length!==0) throw new Error("Unsupported audit arguments");
 if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
 pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,
   connectionTimeoutMillis:10000,ssl:resolveDatabaseTls(),
   options:"-c default_transaction_read_only=on -c statement_timeout=10000"});
 pool.on("error",()=>{idleConnectionFailed=true;});
 const result=audit==="combined-deposit-preflight"
   ? await auditCombinedDepositPreflight(pool)
   : await runReadOnlyDepositAudit(pool);
 // Do not publish a successful report before connection cleanup succeeds.
 await pool.end();
 pool=undefined;
 if(idleConnectionFailed) throw new Error("Audit idle connection failed");
 process.stdout.write(JSON.stringify({audit,...result,financialActivationReady:false,realDepositsEnabled:false})+"\n");
 if(!result.ready) process.exitCode=2;
} catch(error) {
 process.stderr.write(JSON.stringify({audit,ready:false,financialActivationReady:false,realDepositsEnabled:false,
   error:"Audit execution failed; inspect private server logs without sharing secrets",
   code:safeDiagnosticCode(error)})+"\n");
 process.exitCode=3;
} finally {
 if (pool) {
   try { await pool.end(); }
   catch { process.stderr.write("Audit connection cleanup failed.\n"); process.exitCode=3; }
 }
}
