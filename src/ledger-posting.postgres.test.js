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
