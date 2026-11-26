import pg from "pg";
import { safeDiagnosticCode } from "./diagnostic-safety.js";
import { resolveDatabaseTls } from "./database-tls-policy.js";
import { restrictedRuntimeConnectionOptions, guardRestrictedPoolCheckouts } from "./database-session-policy.js";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not configured");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: resolveDatabaseTls(),
  ...restrictedRuntimeConnectionOptions(),
});

if(process.env.PROFINO_RUNTIME_SCHEMA_MODE==="verify-only"){
  guardRestrictedPoolCheckouts(pool);
}

// pg removes a disconnected idle client; handle its error without crashing
// the bot or exposing connection strings from the driver error message.
pool.on("error", error => {
  console.error("[database] idle client error:", safeDiagnosticCode(error));
});

export async function testDatabaseConnection() {
  const result = await pool.query("SELECT NOW() AS server_time");
  return result.rows[0];
}

export async function closeDatabase() {
  await pool.end();
}
