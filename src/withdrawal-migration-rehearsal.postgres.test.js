import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

// Disposable, transaction-scoped rehearsal only. Never point at production.
test("legacy two-state synthetic withdrawal schema upgrades without losing rows and rolls back", {
  skip: !isDisposablePostgresTarget(process.env.DATABASE_URL, "profino_test")
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TEMP TABLE profino_legacy_withdrawal_rehearsal (
        id bigint PRIMARY KEY, user_id bigint NOT NULL, request_key text NOT NULL,
        status text NOT NULL CONSTRAINT legacy_status_check CHECK (status IN ('reserved','cancelled')),
        UNIQUE (user_id, request_key)
      ) ON COMMIT DROP
    `);
    await client.query("INSERT INTO profino_legacy_withdrawal_rehearsal VALUES (1, 10, 'original', 'reserved')");
    await client.query(`
      ALTER TABLE profino_legacy_withdrawal_rehearsal
      ADD COLUMN submitted_hash text UNIQUE,
      ADD COLUMN simulation_payload bytea,
      ADD COLUMN destination text,
      ADD COLUMN payout_event text UNIQUE,
      ADD COLUMN payout_id bigint UNIQUE,
      ADD COLUMN clearing_id bigint,
      ADD COLUMN cancelled_by_reviewer bigint,
      ADD COLUMN release_id bigint UNIQUE
    `);
    await client.query("ALTER TABLE profino_legacy_withdrawal_rehearsal DROP CONSTRAINT legacy_status_check");
    await client.query(`
      ALTER TABLE profino_legacy_withdrawal_rehearsal
      ADD CONSTRAINT upgraded_status_check CHECK (status IN ('reserved','cancelled','pending_receipt','paid')),
      ADD CONSTRAINT upgraded_submission_check CHECK ((status IN ('pending_receipt','paid')) = (submitted_hash IS NOT NULL)),
      ADD CONSTRAINT upgraded_payout_check CHECK (
        (status = 'paid') = (payout_event IS NOT NULL) AND
        (status = 'paid') = (payout_id IS NOT NULL) AND
        (status = 'paid') = (clearing_id IS NOT NULL)
      )
    `);
    const original = await client.query("SELECT id, user_id, request_key, status FROM profino_legacy_withdrawal_rehearsal WHERE id = 1");
    assert.deepEqual(original.rows[0], { id: "1", user_id: "10", request_key: "original", status: "reserved" });
    await client.query("INSERT INTO profino_legacy_withdrawal_rehearsal (id,user_id,request_key,status,submitted_hash) VALUES (2,10,'submitted','pending_receipt','0xtest')");
    await assert.rejects(
      client.query("INSERT INTO profino_legacy_withdrawal_rehearsal (id,user_id,request_key,status) VALUES (3,10,'invalid','paid')"),
      /violates check constraint/
    );
    // A constraint violation aborts this transaction; ROLLBACK is mandatory.
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
