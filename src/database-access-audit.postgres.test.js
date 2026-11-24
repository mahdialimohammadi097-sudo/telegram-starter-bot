import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { inspectDatabaseAccess } from "./database-access-audit.js";
import { runReadOnlyDepositAudit } from "./read-only-deposit-audit.js";
const url = process.env.CATALOG_REHEARSAL_URL;
function safeTarget() {
  if (!url || process.env.PROFINO_DISPOSABLE_POSTGRES !== "yes") return false;
  try {
    const target = new URL(url);
    return ["localhost","127.0.0.1","[::1]"].includes(target.hostname) &&
      target.pathname === "/catalog_rehearsal";
  } catch { return false; }
}
test("PostgreSQL 17 returns bounded current-role evidence inside read-only snapshot", {skip:!safeTarget()}, async () => {
  const pool = new pg.Pool({connectionString:url,max:1});
  try {
    const result = await runReadOnlyDepositAudit(pool, inspectDatabaseAccess);
    assert.equal(result.read_only,true);
    assert.equal(result.server_major,17);
    assert.equal(typeof result.tls,"boolean");
    assert.equal(typeof result.privileged_role_membership,"boolean");
    assert.ok(result.ledger_tables_present>=0 && result.ledger_tables_present<=3);
    await assert.rejects(inspectDatabaseAccess(pool),/incomplete or unsafe/);
  } finally { await pool.end(); }
});

test("real PostgreSQL aborted read-only audit does not return a successful report", {skip:!safeTarget()}, async () => {
  const pool = new pg.Pool({connectionString:url,max:1});
  try {
    await assert.rejects(runReadOnlyDepositAudit(pool, async client => {
      await assert.rejects(client.query("SELECT 1 / 0"), e => e.code === "22012");
      return {ready:true};
    }), /did not commit/);
    assert.equal((await pool.query("SELECT 1 AS value")).rows[0].value,1);
  } finally { await pool.end(); }
});
