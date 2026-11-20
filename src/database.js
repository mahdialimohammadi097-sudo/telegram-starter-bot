import pg from "pg";
import { resolveDatabaseTls } from "./database-tls-policy.js";

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
});

export async function testDatabaseConnection() {
  const result = await pool.query("SELECT NOW() AS server_time");
  return result.rows[0];
}

export async function closeDatabase() {
  await pool.end();
}
