import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { formatCoreSchema, inspectCoreSchema } from "./database-diagnostics.js";

const enabled = Boolean(process.env.DATABASE_URL);
let adminPool;
let pool;
let schema;

before(async () => {
  if (!enabled) return;
  adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  schema = `profino_diag_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema}`
  });

  await pool.query(`
    CREATE TYPE account_state AS ENUM ('active', 'blocked');
    CREATE TABLE ledger_accounts (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      account_type account_state NOT NULL,
      balance NUMERIC(30, 8) NOT NULL,
      CONSTRAINT ledger_account_type_unique
        UNIQUE (account_type) DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT ledger_balance_positive CHECK (balance >= 0)
    );
    CREATE FUNCTION diagnostic_trigger_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RETURN NEW;
    END;
    $$;
    CREATE TABLE ledger_entries (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      account_id BIGINT NOT NULL REFERENCES ledger_accounts(id),
      amount NUMERIC(30, 8) NOT NULL
    );
    CREATE CONSTRAINT TRIGGER ledger_deferred_trigger
      AFTER INSERT ON ledger_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION diagnostic_trigger_fn();
  `);
});

after(async () => {
  if (pool) await pool.end();
  if (adminPool && schema) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});

test("PostgreSQL diagnostics expose numeric, identity, deferred-constraint and trigger metadata", {
  skip: !enabled
}, async () => {
  const snapshot = await inspectCoreSchema(pool);
  const messages = formatCoreSchema(snapshot);
  const all = messages.join("\n");

  const balance = snapshot.columns.find(row =>
    row.table_name === "ledger_accounts" && row.column_name === "balance"
  );
  const id = snapshot.columns.find(row =>
    row.table_name === "ledger_accounts" && row.column_name === "id"
  );
  const accountType = snapshot.columns.find(row =>
    row.table_name === "ledger_accounts" && row.column_name === "account_type"
  );
  const deferredUnique = snapshot.constraints.find(row =>
    row.constraint_name === "ledger_account_type_unique"
  );
  const trigger = snapshot.triggers.find(row =>
    row.trigger_name === "ledger_deferred_trigger"
  );

  assert.equal(balance.numeric_precision, 30);
  assert.equal(balance.numeric_scale, 8);
  assert.equal(id.is_identity, "YES");
  assert.equal(id.identity_generation, "ALWAYS");
  assert.equal(accountType.data_type, "USER-DEFINED");
  assert.equal(accountType.udt_name, "account_state");
  assert.equal(deferredUnique.is_deferrable, true);
  assert.equal(deferredUnique.initially_deferred, true);
  assert.equal(deferredUnique.is_validated, true);
  assert.equal(trigger.enabled_state, "O");
  assert.equal(trigger.is_deferrable, true);
  assert.equal(trigger.initially_deferred, true);
  assert.match(trigger.function_definition, /diagnostic_trigger_fn/);
  assert.match(all, /precision: 30 \| scale: 8/);
  assert.match(all, /deferrable: YES \| initially deferred: YES/);
});
