// One-shot, read-only operator diagnostic for the EXISTING production bot.
// Never starts Telegram, alters schema, or processes money.
import pg from "pg";
import { resolveDatabaseTls } from "../src/database-tls-policy.js";
import { runReadOnlyDepositAudit } from "../src/read-only-deposit-audit.js";
import { safeDiagnosticCode } from "../src/diagnostic-safety.js";
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
  pool.on("error",()=>{});
  const result=await runReadOnlyDepositAudit(pool);
   // Keep the existing unique:... missing markers for operators consuming the
   // old schedule output, while exposing the complete reviewed audit findings.
   const missing=[...result.missing];
   for (const finding of result.incompatible) {
    if (finding.endsWith(":unique_index")) missing.push("unique:"+finding.slice(0,-":unique_index".length));
   }
    output({audit:"fadehost-schema",ready:result.ready,missing,incompatible:result.incompatible,
    financialActivationReady:false,realDepositsEnabled:false});
   if(!result.ready)process.exitCode=2;
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
