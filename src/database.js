import pg from "pg";
import { safeDiagnosticCode } from "./diagnostic-safety.js";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not configured");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: false,
});

// Idle clients can disconnect after network interruptions. PostgreSQL removes
// the failed client automatically; handle the pool event to avoid a process crash.
// Do not log raw error messages: they may include connection details.
pool.on("error", (error) => {
  const code = safeDiagnosticCode(error);
  console.error("[database] idle PostgreSQL client disconnected", { code });
});

export async function testDatabaseConnection() {
  const result = await pool.query("SELECT NOW() AS server_time");
  return result.rows[0];
}

export async function closeDatabase() {
  await pool.end();
}
