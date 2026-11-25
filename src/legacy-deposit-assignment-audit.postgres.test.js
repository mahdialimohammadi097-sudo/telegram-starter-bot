import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import { auditLegacyDepositAssignments } from "./legacy-deposit-assignment-audit.js";

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
      await assert.rejects(pool.query(`INSERT INTO ${table} VALUES (11,103,'active','deposit')`), { code:"23505" });
      await pool.query('DROP INDEX "' + schema + '".reviewed_candidate');
    }
    await pool.query(`ALTER TABLE ${table} ALTER COLUMN wallet_id DROP NOT NULL`);
    await assert.rejects(audit(), /nullable wallet key/);
  } finally {
    try { await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE'); }
    finally { await pool.end(); }
  }
});
