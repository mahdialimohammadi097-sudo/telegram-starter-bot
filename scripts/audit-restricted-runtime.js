// Operator-only: inspect the same runtime role, without starting Telegram,
// modifying roles or schema, or performing any financial operation.
import { verifyRuntimeSchema } from "../src/runtime-schema-policy.js";
import { resolveDatabaseTls } from "../src/database-tls-policy.js";
import pg from "pg";

const reasons = Object.freeze({
  "Required runtime schema object missing": "OBJECT_MISSING",
  "Runtime schema access or resolution mismatch": "ACCESS_MISMATCH",
  "Runtime role has excessive operational or ledger access": "EXCESSIVE_TABLE_PRIVILEGE",
  "Runtime generated ID sequence missing or incompatible": "SEQUENCE_INCOMPATIBLE",
  "Runtime role has excessive database privileges": "EXCESSIVE_DATABASE_PRIVILEGE",
  "Required post history trigger missing or incompatible": "HISTORY_TRIGGER_INCOMPATIBLE",
  "Required restricted owner lock is missing or incompatible": "OWNER_LOCK_INCOMPATIBLE"
});
let pool;
let report = {audit:"restricted-runtime",operationalInventoryVerified:false,financialActivationReady:false};
try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_NOT_CONFIGURED");
  pool = new pg.Pool({
    connectionString:process.env.DATABASE_URL,ssl:resolveDatabaseTls(),max:1,
    connectionTimeoutMillis:10000,
    options:"-c default_transaction_read_only=on -c statement_timeout=10000"
  });
  pool.on("error",()=>{});
  const result = await verifyRuntimeSchema(pool);
  report = {...report,...result};
} catch (error) {
  report.reason = error?.message === "DATABASE_URL_NOT_CONFIGURED" ? "DATABASE_URL_NOT_CONFIGURED" :
    Object.hasOwn(reasons,error?.message) ? reasons[error.message] : "AUDIT_FAILED";
  process.exitCode = report.reason === "AUDIT_FAILED" || report.reason === "DATABASE_URL_NOT_CONFIGURED" ? 3 : 2;
} finally {
  if(pool) {
    try {await pool.end();}
    catch {report={audit:"restricted-runtime",operationalInventoryVerified:false,financialActivationReady:false,reason:"CLEANUP_FAILED"};process.exitCode=3;}
  }
  process.stdout.write(JSON.stringify(report)+"\n");
}
