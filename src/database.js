import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not configured");
}

// TLS is opt-in until the private FadeHost PostgreSQL endpoint is verified.
// When enabled, node-postgres validates the server certificate by default.
const tlsMode = process.env.PROFINO_DATABASE_TLS || "disabled";
if (!["disabled", "verify"].includes(tlsMode)) {
  throw new Error("PROFINO_DATABASE_TLS must be disabled or verify");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: tlsMode === "verify" ? { rejectUnauthorized: true } : false,
});

export async function testDatabaseConnection() {
  const result = await pool.query("SELECT NOW() AS server_time");
  return result.rows[0];
}

export async function closeDatabase() {
  await pool.end();
}
