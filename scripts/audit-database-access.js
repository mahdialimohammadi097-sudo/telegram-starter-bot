// Run manually through an authorized private connection. Never auto-run on startup.
import pg from "pg";
import { resolveDatabaseTls } from "../src/database-tls-policy.js";
import { runCatalogReadOnlyDepositAudit } from "../src/read-only-deposit-audit.js";
import { inspectDatabaseAccess } from "../src/database-access-audit.js";

let pool;
let evidence;
let idleFailure=false;
let failure;
try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: resolveDatabaseTls(),
    max: 1, connectionTimeoutMillis: 10000,
    options: "-c default_transaction_read_only=on -c statement_timeout=10000 -c search_path=pg_catalog" });
  pool.on("error",()=>{idleFailure=true;});
  evidence = await runCatalogReadOnlyDepositAudit(pool, inspectDatabaseAccess);
} catch {
  failure="AUDIT_FAILED";
} finally {
  if (pool) {
    try { await pool.end(); }
    catch { failure="AUDIT_CLEANUP_FAILED"; }
  }
}
if(idleFailure)failure="AUDIT_IDLE_CONNECTION_FAILED";
// Emit exactly one sanitized report only after cleanup, never certify
// production readiness from the privileges of a single connection.
const scope={audit:"database-access",scope:"current-connection-only",financialActivationReady:false,productionReady:false};
if(failure){
  process.stderr.write(JSON.stringify({...scope,error:failure})+"\n");
  process.exitCode=3;
}else{
  process.stdout.write(JSON.stringify({...scope,evidence})+"\n");
}
