import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { formatUsdt } from "./ledger-safety.js";
import { getWalletBalances } from "./wallet-balances.js";
import { postLedgerTransaction, postJournalInTransaction, withLedgerTransaction } from "./ledger-posting.js";

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

  const fixture = new URL("../test/fixtures/ledger-contract.sql", import.meta.url);
  await pool.query(await readFile(fixture, "utf8"));
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
    "INSERT INTO ledger_accounts (account_code, account_type, currency) VALUES ($2, $1, 'USDT') RETURNING id",
    [accountType, randomUUID()]
  );
  return String(result.rows[0].id);
}

async function seedAvailableBalance(accountId, amount) {
  const clearing = await createAccount("CLEARING");
  await postLedgerTransaction({
    pool, transactionType: "test-opening", idempotencyKey: `opening-${accountId}`,
    entries: [
      { account_id: clearing, entry_type: "debit", amount, currency: "USDT" },
      { account_id: accountId, entry_type: "credit", amount, currency: "USDT" }
    ]
  });
}

test("identical concurrent requests produce one posted journal", {
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
  assert.match(outcomes.find((item) => item.status === "rejected").reason.message, /Insufficient available balance/);
  const balance = await pool.query(
    `SELECT SUM(CASE WHEN le.entry_type = 'credit'
                     THEN le.amount ELSE -le.amount END)::text AS balance
       FROM ledger_entries le
       JOIN ledger_transactions lt ON lt.id = le.transaction_id
      WHERE le.account_id = $1 AND lt.status = 'posted'`,
    [available]
  );
  assert.equal(balance.rows[0].balance, "3.000000000000000000");
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
    /Entries of posted transactions cannot be changed/
  );
  await assert.rejects(
    pool.query(
      "DELETE FROM ledger_entries WHERE transaction_id = $1",
      [posted.transactionId]
    ),
    /Entries of posted transactions cannot be changed/
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
      transactionType: "idempotency-mismatch",
      idempotencyKey: "parallel-mismatched-key",
      entries: makeEntries(creditA)
    }),
    postLedgerTransaction({
      pool,
      transactionType: "idempotency-mismatch",
      idempotencyKey: "parallel-mismatched-key",
      entries: makeEntries(creditB)
    })
  ]);

  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.match(outcomes.find((item) => item.status === "rejected").reason.message, /different request/);
  const count = await pool.query(
    "SELECT COUNT(*)::int AS count FROM ledger_transactions WHERE idempotency_key = $1",
    ["parallel-mismatched-key"]
  );
  assert.equal(count.rows[0].count, 1);
});


test("database refuses to mark an unbalanced journal as posted", {
  skip: !enabled
}, async () => {
  const account = await createAccount("CLEARING");
  const transaction = await pool.query(
    `INSERT INTO ledger_transactions
       (transaction_type, idempotency_key, status)
     VALUES ('unbalanced-posting-test', 'unbalanced-posting-blocked', 'pending')
     RETURNING id`
  );
  await pool.query(
    `INSERT INTO ledger_entries
       (transaction_id, account_id, entry_type, amount, currency)
     VALUES ($1, $2, 'debit', 1, 'USDT')`,
    [transaction.rows[0].id, account]
  );

  await assert.rejects(
    pool.query(
      "UPDATE ledger_transactions SET status = 'posted' WHERE id = $1",
      [transaction.rows[0].id]
    ),
    /Transaction [0-9]+ is not balanced/
  );
  const state = await pool.query(
    "SELECT status FROM ledger_transactions WHERE id = $1",
    [transaction.rows[0].id]
  );
  assert.equal(state.rows[0].status, "pending");
});

test("database rejects new entries attached to an already posted journal", {
  skip: !enabled
}, async () => {
  const debit = await createAccount("CLEARING");
  const credit = await createAccount("CLEARING");
  const posted = await postLedgerTransaction({
    pool,
    transactionType: "posted-entry-insert-guard",
    idempotencyKey: "posted-entry-insert-guard",
    entries: [
      { account_id: debit, entry_type: "debit", amount: "3", currency: "USDT" },
      { account_id: credit, entry_type: "credit", amount: "3", currency: "USDT" }
    ]
  });
  const extra = await createAccount("CLEARING");

  await assert.rejects(
    pool.query(
      `INSERT INTO ledger_entries
         (transaction_id, account_id, entry_type, amount, currency)
       VALUES ($1, $2, 'debit', 1, 'USDT')`,
      [posted.transactionId, extra]
    ),
    /Cannot add entries to a posted transaction/
  );
  const count = await pool.query(
    "SELECT COUNT(*)::int AS count FROM ledger_entries WHERE transaction_id = $1",
    [posted.transactionId]
  );
  assert.equal(count.rows[0].count, 2);
});

test("a stored sub-unit balance cannot be silently rounded during posting", {
  skip: !enabled
}, async () => {
  const available = await createAccount("AVAILABLE");
  const clearing = await createAccount("CLEARING");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const journal = await client.query(
      "INSERT INTO ledger_transactions (transaction_type) VALUES ('opening') RETURNING id"
    );
    const id = journal.rows[0].id;
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, entry_type, amount)
       VALUES ($1, $2, 'credit', 1.000000001), ($1, $3, 'debit', 1.000000001)`,
      [id, available, clearing]
    );
    await client.query("UPDATE ledger_transactions SET status = 'posted' WHERE id = $1", [id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await assert.rejects(postLedgerTransaction({
    pool, transactionType: "transfer", idempotencyKey: "sub-unit-balance",
    entries: [
      { account_id: available, entry_type: "debit", amount: "1", currency: "USDT" },
      { account_id: clearing, entry_type: "credit", amount: "1", currency: "USDT" }
    ]
  }), /exceeds eight decimal places/);
  const result = await pool.query(
    "SELECT id FROM ledger_transactions WHERE idempotency_key = 'sub-unit-balance'"
  );
  assert.equal(result.rowCount, 0);
});

test("two approvals of one simulated deposit credit the customer's wallet once", {
  skip: !enabled
}, async () => {
  const { rows: [user] } = await pool.query("INSERT INTO users (id) VALUES (501) RETURNING id");
  const clearing = await createAccount("CLEARING");
  await pool.query(
    `INSERT INTO ledger_accounts (user_id, account_code, account_type)
     SELECT $1, 'simulation:' || kind, kind
     FROM unnest(ARRAY['AVAILABLE', 'INVESTED', 'PROFIT']) AS kind`,
    [user.id]
  );
  // Only the columns involved in the simulated review are needed here.
  await pool.query(`
    CREATE TABLE deposit_requests (
      id bigserial PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES users(id),
      amount numeric NOT NULL CHECK (amount > 0),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      reviewed_at timestamptz
    )
  `);
  const { rows: [request] } = await pool.query(
    "INSERT INTO deposit_requests (user_id, amount) VALUES ($1, 25) RETURNING id", [user.id]
  );

  function simulateApproval() {
    return withLedgerTransaction(pool, async client => {
      const { rows: [deposit] } = await client.query(
        `SELECT d.status, trim_scale(d.amount)::text AS amount, a.id AS account_id
         FROM deposit_requests d JOIN ledger_accounts a ON a.user_id = d.user_id
         WHERE d.id = $1 AND a.account_type = 'AVAILABLE' AND a.currency = 'USDT'
         FOR UPDATE OF d`, [request.id]
      );
      if (deposit.status === "rejected") throw new Error("Request already rejected");
      const journal = await postJournalInTransaction(client, {
        transactionType: "simulated-deposit", referenceId: request.id,
        idempotencyKey: `simulated-deposit:${request.id}`,
        entries: [
          { account_id: clearing, entry_type: "debit", amount: deposit.amount, currency: "USDT" },
          { account_id: deposit.account_id, entry_type: "credit", amount: deposit.amount, currency: "USDT" }
        ]
      });
      if (deposit.status === "pending") {
        await client.query(
          "UPDATE deposit_requests SET status = 'approved', reviewed_at = now() WHERE id = $1",
          [request.id]
        );
      }
      return journal;
    });
  }

  async function displayedBalances() {
    const balances = await getWalletBalances(pool, user.id);
    return Object.values(balances).map(formatUsdt);
  }

  assert.deepEqual(await displayedBalances(), Array(3).fill("0.00000000"));
  // Force review failure after journal insertion. The credit must also roll back.
  await pool.query("ALTER TABLE deposit_requests ADD CONSTRAINT force_failure CHECK (status <> 'approved')");
  await assert.rejects(simulateApproval(), { code: "23514" });
  assert.deepEqual(await displayedBalances(), Array(3).fill("0.00000000"));
  await pool.query("ALTER TABLE deposit_requests DROP CONSTRAINT force_failure");
  const [first, second] = await Promise.all([simulateApproval(), simulateApproval()]);
  assert.equal(first.transactionId, second.transactionId);
  assert.notEqual(first.idempotent, second.idempotent);
  assert.equal((await simulateApproval()).idempotent, true);
  assert.deepEqual(await displayedBalances(), ["25.00000000", "0.00000000", "0.00000000"]);
  const review = await pool.query("SELECT status, reviewed_at FROM deposit_requests WHERE id = $1", [request.id]);
  assert.equal(review.rows[0].status, "approved");
  assert.ok(review.rows[0].reviewed_at);
});
