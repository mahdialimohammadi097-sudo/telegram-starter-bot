import pg from "pg";

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

// An idle PostgreSQL client may emit an error after the connection is lost.
// Without a pool error listener, Node.js treats this as an uncaught error and exits.
// pg removes the failed idle client from the pool; future queries can reconnect.
pool.on("error", (error) => {
  console.error("[database] idle PostgreSQL client error:", {
    code: error?.code ?? "unknown",
    message: error?.message ?? "unknown"
  });
});

export async function testDatabaseConnection() {
  const result = await pool.query("SELECT NOW() AS server_time");
  return result.rows[0];
}

export async function closeDatabase() {
  await pool.end();
}
