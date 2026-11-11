import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { postLedgerTransaction } from "./ledger-posting.js";

const enabled = Boolean(process.env.DATABASE_URL);
let adminPool;
let pool;
let schema;

before(async () => {
  if (!enabled) return;
  adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  schema = `profino_it_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema}`
  });

  await pool.query(`
    CREATE TABLE ledger_accounts (
      id BIGSERIAL PRIMARY KEY,
      account_type TEXT NOT NULL,
      currency TEXT NOT NULL CHECK (currency = 'USDT')
    );
    CREATE TABLE ledger_transactions (
      id BIGSERIAL PRIMARY KEY,
      transaction_type TEXT NOT NULL,
      reference_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      description TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'posted'))
    );
    CREATE TABLE ledger_entries (
      id BIGSERIAL PRIMARY KEY,
      transaction_id BIGINT NOT NULL REFERENCES ledger_transactions(id),
      account_id BIGINT NOT NULL REFERENCES ledger_accounts(id),
      entry_type TEXT NOT NULL CHECK (entry_type IN ('debit', 'credit')),
      amount NUMERIC(30, 8) NOT NULL CHECK (amount > 0),
      currency TEXT NOT NULL CHECK (currency = 'USDT')
    );
  `);
});

after(async () => {
  if (pool) await pool.end();
  if (adminPool && schema) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});

async function createAccount(accountType = "AVAILABLE") {
  const result = await pool.query(
    "INSERT INTO ledger_accounts (account_type, currency) VALUES ($1, 'USDT') RETURNING id",
    [accountType]
  );
  return String(result.rows[0].id);
}

async function seedAvailableBalance(accountId, amount) {
  const transaction = await pool.query(
    `INSERT INTO ledger_transactions
       (transaction_type, idempotency_key, status)
     VALUES ('test-opening', $1, 'posted') RETURNING id`,
    [`opening-${accountId}`]
  );
  await pool.query(
    `INSERT INTO ledger_entries
       (transaction_id, account_id, entry_type, amount, currency)
     VALUES ($1, $2, 'credit', $3, 'USDT')`,
    [transaction.rows[0].id, accountId, amount]
  );
}

test("PostgreSQL 17 integration tests are enabled only with DATABASE_URL", {
  skip: !enabled
}, async () => {
  const debit = await createAccount("CLEARING");
  const credit = await createAccount("CLEARING");
  const entries = [
    { account_id: debit, entry_type: "debit", amount: "1.25", currency: "USDT" },
    { account_id: credit, entry_type: "credit", amount: "1.25", currency: "USDT" }
  ];

  const [first, replay] = await Promise.all([
    postLedgerTransaction({
      pool, transactionType: "integration-test",
      idempotencyKey: "parallel-identical-key", entries
    }),
    postLedgerTransaction({
      pool, transactionType: "integration-test",
      idempotencyKey: "parallel-identical-key", entries
    })
  ]);

  assert.equal(first.transactionId, replay.transactionId);
  assert.equal(first.posted, true);
  assert.equal(replay.posted, true);
  assert.equal([first.idempotent, replay.idempotent].filter(Boolean).length, 1);

  const count = await pool.query(
    "SELECT COUNT(*)::int AS count FROM ledger_transactions WHERE idempotency_key = $1",
    ["parallel-identical-key"]
  );
  assert.equal(count.rows[0].count, 1);
});

test("row locks prevent concurrent AVAILABLE overdrafts", {
  skip: !enabled
}, async () => {
  const available = await createAccount("AVAILABLE");
  const clearingA = await createAccount("CLEARING");
  const clearingB = await createAccount("CLEARING");
  await seedAvailableBalance(available, "10.00000000");

  const makeEntries = (clearing) => [
    { account_id: available, entry_type: "debit", amount: "7", currency: "USDT" },
    { account_id: clearing, entry_type: "credit", amount: "7", currency: "USDT" }
  ];
  const outcomes = await Promise.allSettled([
    postLedgerTransaction({
      pool, transactionType: "concurrent-debit",
      idempotencyKey: "concurrent-debit-a", entries: makeEntries(clearingA)
    }),
    postLedgerTransaction({
      pool, transactionType: "concurrent-debit",
      idempotencyKey: "concurrent-debit-b", entries: makeEntries(clearingB)
    })
  ]);

  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
  const balance = await pool.query(
    `SELECT SUM(CASE WHEN le.entry_type = 'credit'
                     THEN le.amount ELSE -le.amount END)::text AS balance
       FROM ledger_entries le
       JOIN ledger_transactions lt ON lt.id = le.transaction_id
      WHERE le.account_id = $1 AND lt.status = 'posted'`,
    [available]
  );
  assert.equal(balance.rows[0].balance, "3.00000000");
});


test("PostgreSQL rolls back the whole journal when an entry insert fails", {
  skip: !enabled
}, async () => {
  const debit = await createAccount("CLEARING");
  const credit = await createAccount("CLEARING");

  await pool.query(`
    CREATE OR REPLACE FUNCTION profino_test_reject_credit()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.entry_type = 'credit' AND NEW.amount = 9.99 THEN
        RAISE EXCEPTION 'forced integration-test entry failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER profino_test_reject_credit
    BEFORE INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION profino_test_reject_credit();
  `);

  await assert.rejects(
    postLedgerTransaction({
      pool,
      transactionType: "integration-rollback-test",
      idempotencyKey: "postgres-forced-entry-failure",
      entries: [
        { account_id: debit, entry_type: "debit", amount: "9.99", currency: "USDT" },
        { account_id: credit, entry_type: "credit", amount: "9.99", currency: "USDT" }
      ]
    }),
    /forced integration-test entry failure/
  );

  const transactions = await pool.query(
    "SELECT COUNT(*)::int AS count FROM ledger_transactions WHERE idempotency_key = $1",
    ["postgres-forced-entry-failure"]
  );
  const entries = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM ledger_entries le
       JOIN ledger_transactions lt ON lt.id = le.transaction_id
      WHERE lt.idempotency_key = $1`,
    ["postgres-forced-entry-failure"]
  );
  assert.equal(transactions.rows[0].count, 0);
  assert.equal(entries.rows[0].count, 0);
});


test("deferred constraint-trigger failure at COMMIT rolls back the entire journal", {
  skip: !enabled
}, async () => {
  const debit = await createAccount("CLEARING");
  const credit = await createAccount("CLEARING");

  await pool.query(`
    CREATE OR REPLACE FUNCTION profino_test_deferred_reject()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.amount = 8.88 THEN
        RAISE EXCEPTION 'forced deferred constraint failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER profino_test_deferred_reject
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION profino_test_deferred_reject();
  `);

  await assert.rejects(
    postLedgerTransaction({
      pool,
      transactionType: "deferred-trigger-rollback-test",
      idempotencyKey: "postgres-deferred-trigger-failure",
      entries: [
        { account_id: debit, entry_type: "debit", amount: "8.88", currency: "USDT" },
        { account_id: credit, entry_type: "credit", amount: "8.88", currency: "USDT" }
      ]
    }),
    /forced deferred constraint failure/
  );

  const transactions = await pool.query(
    "SELECT COUNT(*)::int AS count FROM ledger_transactions WHERE idempotency_key = $1",
    ["postgres-deferred-trigger-failure"]
  );
  const entries = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM ledger_entries le
       JOIN ledger_transactions lt ON lt.id = le.transaction_id
      WHERE lt.idempotency_key = $1`,
    ["postgres-deferred-trigger-failure"]
  );
  assert.equal(transactions.rows[0].count, 0);
  assert.equal(entries.rows[0].count, 0);
});

test("posted ledger entries reject UPDATE and DELETE mutations", {
  skip: !enabled
}, async () => {
  const debit = await createAccount("CLEARING");
  const credit = await createAccount("CLEARING");

  await pool.query(`
    CREATE OR REPLACE FUNCTION profino_test_prevent_posted_entry_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE parent_status TEXT;
    BEGIN
      SELECT status INTO parent_status
      FROM ledger_transactions
      WHERE id = OLD.transaction_id;
      IF parent_status = 'posted' THEN
        RAISE EXCEPTION 'posted ledger entries are immutable';
      END IF;
      RETURN OLD;
    END;
    $$;
    CREATE TRIGGER profino_test_prevent_posted_entry_update
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION profino_test_prevent_posted_entry_mutation();
  `);

  const posted = await postLedgerTransaction({
    pool,
    transactionType: "immutability-test",
    idempotencyKey: "postgres-posted-entry-immutability",
    entries: [
      { account_id: debit, entry_type: "debit", amount: "4.25", currency: "USDT" },
      { account_id: credit, entry_type: "credit", amount: "4.25", currency: "USDT" }
    ]
  });

  await assert.rejects(
    pool.query(
      "UPDATE ledger_entries SET amount = 99.99 WHERE transaction_id = $1",
      [posted.transactionId]
    ),
    /posted ledger entries are immutable/
  );
  await assert.rejects(
    pool.query(
      "DELETE FROM ledger_entries WHERE transaction_id = $1",
      [posted.transactionId]
    ),
    /posted ledger entries are immutable/
  );

  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM ledger_entries WHERE transaction_id = $1",
    [posted.transactionId]
  );
  assert.equal(result.rows[0].count, 2);
});

test("concurrent reuse of one idempotency key with different payloads cannot double-post", {
  skip: !enabled
}, async () => {
  const debit = await createAccount("CLEARING");
  const creditA = await createAccount("CLEARING");
  const creditB = await createAccount("CLEARING");
  const makeEntries = (credit) => [
    { account_id: debit, entry_type: "debit", amount: "2.5", currency: "USDT" },
    { account_id: credit, entry_type: "credit", amount: "2.5", currency: "USDT" }
  ];

  const outcomes = await Promise.allSettled([
    postLedgerTransaction({
      pool,
      transactionType: "concurrent-idempotency-mismatch",
      idempotencyKey: "parallel-mismatched-key",
      entries: makeEntries(creditA)
    }),
    postLedgerTransaction({
      pool,
      transactionType: "concurrent-idempotency-mismatch",
      idempotencyKey: "parallel-mismatched-key",
      entries: makeEntries(creditB)
    })
  ]);

  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
  const count = await pool.query(
    "SELECT COUNT(*)::int AS count FROM ledger_transactions WHERE idempotency_key = $1",
    ["parallel-mismatched-key"]
  );
  assert.equal(count.rows[0].count, 1);
});
