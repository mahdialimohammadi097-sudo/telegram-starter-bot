import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import { auditLegacyDepositAssignments, auditCombinedDepositPreflight } from "./legacy-deposit-assignment-audit.js";

const url = process.env.CATALOG_REHEARSAL_URL;
const enabled = isDisposablePostgresTarget(url, "catalog_rehearsal");

test("legacy assignment audit rejects unsafe schema identifiers before connecting", async () => {
  for (const schema of ["", "public;drop", "a".repeat(64), null, {}, "UPPER"]) {
    await assert.rejects(auditLegacyDepositAssignments({
      async connect() { assert.fail("must not connect"); }
    }, { schema }), /Invalid assignment audit schema/);
  }
});

test("legacy assignment audit counts collisions and requires the exact live unique index in PostgreSQL", { skip: !enabled }, async () => {
  const pool = new pg.Pool({ connectionString: url });
  const schema = "assignment_audit_" + randomUUID().replaceAll("-", "");
  const table = '"' + schema + '".user_wallet_assignments';
  try {
    await pool.query('CREATE SCHEMA "' + schema + '"');
    await pool.query(`CREATE TABLE ${table} (
      wallet_id bigint NOT NULL, user_id bigint NOT NULL, status text NOT NULL, assignment_type text NOT NULL
    )`);
    await pool.query(`INSERT INTO ${table} VALUES
      (11,101,'active','deposit'),(11,102,'active','deposit'),
      (12,101,'active','deposit'),(12,102,'active','deposit'),
      (13,101,'inactive','deposit'),(13,102,'inactive','deposit'),
      (14,101,'active','withdrawal'),(14,102,'active','withdrawal')`);
    const audit = () => auditLegacyDepositAssignments(pool, { schema });
    assert.deepEqual(await audit(), {
      ready:false, conflictingActiveDepositWallets:"2",
      activeDepositWalletUniquenessEnforced:false, realDepositsEnabled:false
    });
    await pool.query(`DELETE FROM ${table} WHERE user_id=102 AND status='active' AND assignment_type='deposit'`);
    assert.equal((await audit()).ready,false);
    const cases = [
      "(wallet_id,user_id) WHERE status='active' AND assignment_type='deposit'",
      "(wallet_id) WHERE status='active' AND assignment_type='deposit' AND user_id=101",
      "(wallet_id) WHERE status='inactive' AND assignment_type='withdrawal'",
      "((wallet_id+0)) WHERE status='active' AND assignment_type='deposit'"
    ];
    for (const definition of cases) {
      await pool.query(`CREATE UNIQUE INDEX reviewed_candidate ON ${table} ${definition}`);
      const report = await audit();
      assert.equal(report.conflictingActiveDepositWallets,"0");
      assert.equal(report.activeDepositWalletUniquenessEnforced,false);
      assert.equal(report.ready,false);
      await pool.query('DROP INDEX "' + schema + '".reviewed_candidate');
    }
    for (const predicate of [
      "status='active' AND assignment_type='deposit'",
      "assignment_type='deposit' AND status='active'"
    ]) {
      await pool.query(`CREATE UNIQUE INDEX reviewed_candidate ON ${table}(wallet_id) WHERE ${predicate}`);
      assert.deepEqual(await audit(), {
        ready:true, conflictingActiveDepositWallets:"0",
        activeDepositWalletUniquenessEnforced:true, realDepositsEnabled:false
      });
      const combined = await auditCombinedDepositPreflight(pool, { schema });
      assert.equal(combined.assignments.ready,true);
      assert.equal(combined.historicalBasicGuardsPresent,false);
      assert.equal(combined.ready,false);
      assert.equal(combined.realDepositsEnabled,false);
      await assert.rejects(pool.query(`INSERT INTO ${table} VALUES (11,103,'active','deposit')`), { code:"23505" });
      await pool.query('DROP INDEX "' + schema + '".reviewed_candidate');
    }
    // An unlogged table can lose all wallet assignments after a crash.
    // Even an otherwise valid immediate unique index is insufficient.
    await pool.query(`CREATE UNIQUE INDEX reviewed_candidate ON ${table}(wallet_id) WHERE status='active' AND assignment_type='deposit'`);
    assert.equal((await audit()).ready,true);
    await pool.query(`ALTER TABLE ${table} SET UNLOGGED`);
    await assert.rejects(audit(), /Unsupported assignment relation/);
    await pool.query(`ALTER TABLE ${table} SET LOGGED`);
    assert.equal((await audit()).ready,true);
    await pool.query('DROP INDEX "' + schema + '".reviewed_candidate');
    await pool.query(`ALTER TABLE ${table} ALTER COLUMN wallet_id DROP NOT NULL`);
    await assert.rejects(audit(), /nullable wallet key/);
  } finally {
    try { await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE'); }
    finally { await pool.end(); }
  }
});

test("legacy assignment audit fails closed when RLS would hide wallet collisions", { skip: !enabled }, async () => {
  const pool = new pg.Pool({ connectionString: url });
  const suffix = randomUUID().replaceAll("-", "");
  const schema = "assignment_rls_" + suffix;
  const role = "assignment_reader_" + suffix;
  const table = '"' + schema + '".user_wallet_assignments';
  const client = await pool.connect();
  try {
    await client.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`CREATE TABLE ${table} (
      wallet_id bigint NOT NULL, user_id bigint NOT NULL,
      status text NOT NULL, assignment_type text NOT NULL
    )`);
    await client.query(`INSERT INTO ${table} VALUES
      (11,101,'active','deposit'),(11,102,'active','deposit')`);
    await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await client.query(`GRANT SELECT ON ${table} TO "${role}"`);
    const audit = () => auditLegacyDepositAssignments({
      async connect() {
        return { query: (...args) => client.query(...args), release() {} };
      }
    }, { schema });
    await client.query(`SET ROLE "${role}"`);
    assert.equal((await audit()).conflictingActiveDepositWallets, "1");
    await client.query("RESET ROLE");
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await client.query(`CREATE POLICY visible_user ON ${table} FOR SELECT TO "${role}" USING (user_id=101)`);
    await client.query(`SET ROLE "${role}"`);
    assert.equal((await client.query(`SELECT count(*)::text AS count FROM ${table}`)).rows[0].count, "1");
    await assert.rejects(audit(), { code: "42501" });
    assert.equal((await client.query("SELECT current_setting('row_security') AS setting")).rows[0].setting, "on");
    assert.equal((await client.query("SELECT 1 AS healthy")).rows[0].healthy, 1);
  } finally {
    try {
      await client.query("RESET ROLE");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally {
      client.release();
      await pool.end();
    }
  }
});
