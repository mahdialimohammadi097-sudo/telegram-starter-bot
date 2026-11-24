// Run manually through an authorized private connection. Never auto-run on startup.
import pg from "pg";
import { resolveDatabaseTls } from "../src/database-tls-policy.js";
import { runReadOnlyDepositAudit } from "../src/read-only-deposit-audit.js";
import { inspectDatabaseAccess } from "../src/database-access-audit.js";
let pool;
try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: resolveDatabaseTls(),
    max: 1, connectionTimeoutMillis: 10000,
    options: "-c default_transaction_read_only=on -c statement_timeout=10000 -c search_path=pg_catalog" });
  const evidence = await runReadOnlyDepositAudit(pool, inspectDatabaseAccess);
  process.stdout.write(JSON.stringify({ audit: "database-access", scope: "current-connection-only", evidence }) + "\n");
} catch {
  process.stderr.write(JSON.stringify({ audit: "database-access", error: "AUDIT_FAILED" }) + "\n");
  process.exitCode = 3;
} finally {
  if (pool) {
    try { await pool.end(); }
    catch { process.stderr.write("Audit cleanup failed.\n"); process.exitCode = 3; }
  }
}
