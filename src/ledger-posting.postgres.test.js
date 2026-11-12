import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { readTestnetTransfer } from "../test-support/bsc-testnet-receipt.js";
import { findSimulationDiscrepancies } from "../test-support/reconcile-simulated-deposits.js";
import { formatUsdt } from "./ledger-safety.js";
import { getWalletBalances } from "./wallet-balances.js";
import { postLedgerTransaction, postJournalInTransaction, withLedgerTransaction } from "./ledger-posting.js";

const enabled = Boolean(process.env.DATABASE_URL);
let adminPool;
let pool;
let schema;
let simulationClearing;

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
  simulationClearing = await createAccount("CLEARING");
  // Only the columns involved in the simulated review are needed here.
  await pool.query(`
    CREATE TABLE deposit_requests (
      id bigserial PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES users(id),
      amount numeric NOT NULL CHECK (amount > 0),
      transfer_event text NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      reviewed_at timestamptz
    )
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

async function createSimulationWallet(id) {
  const { rows: [user] } = await pool.query("INSERT INTO users (id) VALUES ($1) RETURNING id", [id]);
  await pool.query(
    `INSERT INTO ledger_accounts (user_id, account_code, account_type)
     SELECT $1, 'simulation:' || $1::bigint::text || ':' || kind, kind
     FROM unnest(ARRAY['AVAILABLE', 'INVESTED', 'PROFIT']) AS kind`,
    [user.id]
  );
  return user.id;
}

async function displayedBalances(userId) {
  const balances = await getWalletBalances(pool, userId);
  return Object.values(balances).map(formatUsdt);
}

function approveSimulatedClaim(requestId, observedTransfers, workerPool = pool) {
  return withLedgerTransaction(workerPool, client => reviewSimulatedClaim(client, requestId, observedTransfers));
}

async function reviewSimulatedClaim(client, requestId, observedTransfers) {
  const { rows: [deposit] } = await client.query(
    `SELECT d.user_id, d.status, d.transfer_event, trim_scale(d.amount)::text AS amount, a.id AS account_id
     FROM deposit_requests d JOIN ledger_accounts a ON a.user_id = d.user_id
     WHERE d.id = $1 AND a.account_type = 'AVAILABLE' AND a.currency = 'USDT'
     FOR UPDATE OF d`, [requestId]
  );
  if (deposit.status === "rejected") throw new Error("Request already rejected");
  const observed = observedTransfers.get(deposit.transfer_event);
  if (!observed || observed.userId !== deposit.user_id || observed.amount !== deposit.amount) {
    throw new Error("Claim does not match the simulated transfer");
  }
  const journal = await postJournalInTransaction(client, {
    transactionType: "simulated-deposit", referenceId: requestId,
    idempotencyKey: `simulated-deposit:${deposit.transfer_event}`,
    entries: [
      { account_id: simulationClearing, entry_type: "debit", amount: deposit.amount, currency: "USDT" },
      { account_id: deposit.account_id, entry_type: "credit", amount: deposit.amount, currency: "USDT" }
    ]
  });
  if (deposit.status === "pending") {
    await client.query(
      "UPDATE deposit_requests SET status = 'approved', reviewed_at = now() WHERE id = $1",
      [requestId]
    );
  }
  return journal;
}

test("two approvals of one simulated deposit credit the customer's wallet once", {
  skip: !enabled
}, async () => {
  const userId = await createSimulationWallet(501);
  const observed = new Map([
    ["test-chain:sample-tx:0", { userId, amount: "25" }],
    ["test-chain:sample-tx:1", { userId, amount: "25" }]
  ]);
  const { rows: [request] } = await pool.query(
    "INSERT INTO deposit_requests (user_id, amount, transfer_event) VALUES ($1, 25, 'test-chain:sample-tx:0') RETURNING id", [userId]
  );

  const simulateApproval = (id = request.id) => approveSimulatedClaim(id, observed);

  assert.deepEqual(await displayedBalances(userId), Array(3).fill("0.00000000"));
  // Force review failure after journal insertion. The credit must also roll back.
  await pool.query("ALTER TABLE deposit_requests ADD CONSTRAINT force_failure CHECK (status <> 'approved')");
  await assert.rejects(simulateApproval(), { code: "23514" });
  assert.deepEqual(await displayedBalances(userId), Array(3).fill("0.00000000"));
  await pool.query("ALTER TABLE deposit_requests DROP CONSTRAINT force_failure");
  const [first, second] = await Promise.all([simulateApproval(), simulateApproval()]);
  assert.equal(first.transactionId, second.transactionId);
  assert.notEqual(first.idempotent, second.idempotent);
  assert.equal((await simulateApproval()).idempotent, true);
  assert.deepEqual(await displayedBalances(userId), ["25.00000000", "0.00000000", "0.00000000"]);
  const review = await pool.query("SELECT status, reviewed_at FROM deposit_requests WHERE id = $1", [request.id]);
  assert.equal(review.rows[0].status, "approved");
  assert.ok(review.rows[0].reviewed_at);

  // Two distinct claims reference the same synthetic transfer log. The ledger
  // key identifies the log, while referenceId identifies the winning request.
  const claims = await pool.query(
    `INSERT INTO deposit_requests (user_id, amount, transfer_event)
     VALUES ($1, 25, 'test-chain:sample-tx:1'), ($1, 25, 'test-chain:sample-tx:1')
     RETURNING id`, [userId]
  );
  const outcomes = await Promise.allSettled(claims.rows.map(row => simulateApproval(row.id)));
  assert.equal(outcomes.filter(row => row.status === "fulfilled").length, 1);
  assert.match(outcomes.find(row => row.status === "rejected").reason.message, /different request/);
  const reviews = await pool.query(
    "SELECT id, status FROM deposit_requests WHERE transfer_event = $1 ORDER BY status",
    ["test-chain:sample-tx:1"]
  );
  assert.deepEqual(reviews.rows.map(row => row.status), ["approved", "pending"]);
  assert.equal((await simulateApproval(reviews.rows[0].id)).idempotent, true);
  await assert.rejects(simulateApproval(reviews.rows[1].id), /different request/);
  assert.deepEqual(await displayedBalances(userId), ["50.00000000", "0.00000000", "0.00000000"]);
});

test("an early claim cannot divert another wallet's simulated deposit", { skip: !enabled }, async () => {
  const owner = await createSimulationWallet(502);
  const other = await createSimulationWallet(503);
  // Trusted test input, prepared independently of the submitted claims.
  const event = "test-chain:ownership-tx:0";
  const observed = new Map([[event, { userId: owner, amount: "25" }]]);
  async function claim(userId, amount, eventId) {
    const result = await pool.query(
      "INSERT INTO deposit_requests (user_id, amount, transfer_event) VALUES ($1, $2, $3) RETURNING id",
      [userId, amount, eventId]
    );
    return approveSimulatedClaim(result.rows[0].id, observed);
  }
  await assert.rejects(claim(other, "25", event), /does not match/);
  await assert.rejects(claim(owner, "25.00000001", event), /does not match/);
  await assert.rejects(claim(owner, "25", "test-chain:unknown:0"), /does not match/);
  assert.deepEqual(await displayedBalances(other), Array(3).fill("0.00000000"));
  assert.deepEqual(await displayedBalances(owner), Array(3).fill("0.00000000"));
  const journal = await claim(owner, "25.00000000", event);
  assert.equal(journal.idempotent, false);
  assert.deepEqual(await displayedBalances(owner), ["25.00000000", "0.00000000", "0.00000000"]);
  assert.deepEqual(await displayedBalances(other), Array(3).fill("0.00000000"));
});

test("a captured finalized testnet receipt credits the simulated wallet once", { skip: !enabled }, async () => {
  const sample = JSON.parse(await readFile(
    new URL("../test/fixtures/bsc-testnet-transfer.json", import.meta.url), "utf8"
  ));
  const owner = await createSimulationWallet(504);
  const { rows: [request] } = await pool.query(
    "INSERT INTO deposit_requests (user_id, amount, transfer_event) VALUES ($1, $2, $3) RETURNING id",
    [owner, sample.result.amount, sample.result.event]
  );
  // This test assigns the public sample recipient to a synthetic user.
  async function approveFromReceipt(observation, walletConfig) {
    const transfer = readTestnetTransfer(observation, walletConfig);
    const observed = new Map([[transfer.event, { userId: owner, amount: transfer.amount }]]);
    return approveSimulatedClaim(request.id, observed);
  }
  const otherAddress = "0x" + "11".repeat(20);
  for (const field of ["contract", "recipient"]) {
    await assert.rejects(approveFromReceipt(sample.observation, { ...sample.expected, [field]: otherAddress }));
  }
  assert.deepEqual(await displayedBalances(owner), Array(3).fill("0.00000000"));
  await pool.query(`
    CREATE TABLE simulation_wallet_assignments (recipient text PRIMARY KEY, user_id bigint REFERENCES users(id));
    CREATE TABLE simulation_inbox (request_id bigint PRIMARY KEY REFERENCES deposit_requests(id),
      observation jsonb NOT NULL, expected jsonb NOT NULL)
  `);
  await pool.query("INSERT INTO simulation_wallet_assignments VALUES ($1, $2)", [sample.expected.recipient, owner]);
  await pool.query("INSERT INTO simulation_inbox VALUES ($1, $2, $3)", [request.id, sample.observation, sample.expected]);

  async function processFromNewConnection() {
    const worker = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
    try {
      const { rows: [item] } = await worker.query(
        `SELECT i.*, w.user_id FROM simulation_inbox i
         JOIN simulation_wallet_assignments w ON w.recipient = i.expected->>'recipient'`
      );
      const transfer = readTestnetTransfer(item.observation, item.expected);
      return await approveSimulatedClaim(item.request_id, new Map([
        [transfer.event, { userId: item.user_id, amount: transfer.amount }]
      ]), worker);
    } finally {
      await worker.end();
    }
  }
  // The first worker commits and exits before acknowledging the inbox item.
  const first = await processFromNewConnection();
  assert.equal(first.idempotent, false);
  const replays = await Promise.all([processFromNewConnection(), processFromNewConnection()]);
  for (const replay of replays) {
    assert.equal(replay.transactionId, first.transactionId);
    assert.equal(replay.idempotent, true);
  }
  assert.deepEqual(await displayedBalances(owner), ["1.00000000", "0.00000000", "0.00000000"]);
});

test("independent reconciliation detects a missing credit, an orphan journal and a wrong amount", {
  skip: !enabled
}, async () => {
  const owner = await createSimulationWallet(505);
  const event = "test-chain:reconcile:0";
  const { rows: [request] } = await pool.query(
    "INSERT INTO deposit_requests (user_id, amount, transfer_event) VALUES ($1, 25, $2) RETURNING id",
    [owner, event]
  );
  const journal = await approveSimulatedClaim(request.id, new Map([[event, { userId: owner, amount: "25" }]]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const discrepancies = () => findSimulationDiscrepancies(client, simulationClearing);
    assert.deepEqual(await discrepancies(), []);
    // Posted entries and their journal must reject edits even inside a review transaction.
    for (const change of [
      "UPDATE ledger_entries SET amount = 24 WHERE transaction_id = $1 AND entry_type = 'credit'",
      "UPDATE ledger_entries SET account_id = (SELECT id FROM ledger_accounts WHERE user_id = 505 AND account_type = 'INVESTED') WHERE transaction_id = $1 AND entry_type = 'credit'",
      "DELETE FROM ledger_entries WHERE transaction_id = $1 AND entry_type = 'debit'",
      "UPDATE ledger_transactions SET idempotency_key = 'simulation:wrong-event' WHERE id = $1"
    ]) {
      await client.query("SAVEPOINT valid_journal");
      await assert.rejects(client.query(change, [journal.transactionId]), /cannot be changed|immutable/i);
      await client.query("ROLLBACK TO SAVEPOINT valid_journal");
      await client.query("RELEASE SAVEPOINT valid_journal");
    }
    assert.deepEqual(await discrepancies(), []);
    await client.query("UPDATE deposit_requests SET transfer_event = 'test-chain:wrong:0' WHERE id = $1", [request.id]);
    assert.deepEqual(await discrepancies(), [{ request_id: request.id, journal_id: journal.transactionId }]);
    await client.query("UPDATE deposit_requests SET transfer_event = $2 WHERE id = $1", [request.id, event]);
    await client.query("UPDATE deposit_requests SET amount = 30 WHERE id = $1", [request.id]);
    assert.deepEqual(await discrepancies(), [{ request_id: request.id, journal_id: journal.transactionId }]);
    await client.query("UPDATE deposit_requests SET status = 'pending' WHERE id = $1", [request.id]);
    assert.deepEqual(await discrepancies(), [{ request_id: null, journal_id: journal.transactionId }]);
    await client.query("UPDATE deposit_requests SET status = 'approved', amount = 25 WHERE id = $1", [request.id]);
    const { rows: [missing] } = await client.query(
      `INSERT INTO deposit_requests (user_id, amount, transfer_event, status)
       VALUES ($1, 10, 'test-chain:missing:0', 'approved') RETURNING id`, [owner]
    );
    assert.deepEqual(await discrepancies(), [{ request_id: missing.id, journal_id: null }]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("disconnect before commit rolls back the simulated approval and allows recovery", { skip: !enabled }, async () => {
  const owner = await createSimulationWallet(506);
  const event = "test-chain:disconnect-before-commit:0";
  const observed = new Map([[event, { userId: owner, amount: "25" }]]);
  const { rows: [request] } = await pool.query(
    "INSERT INTO deposit_requests (user_id, amount, transfer_event) VALUES ($1, 25, $2) RETURNING id",
    [owner, event]
  );
  const interrupted = await pool.connect();
  let discardedJournal;
  try {
    await interrupted.query("BEGIN");
    discardedJournal = await reviewSimulatedClaim(interrupted, request.id, observed);
    assert.equal(discardedJournal.posted, true);
  } finally {
    // Destroy the open connection without issuing COMMIT or ROLLBACK.
    interrupted.release(true);
  }

  // Wait for PostgreSQL to release the interrupted transaction's row lock.
  const { rows: [pending] } = await pool.query(
    "SELECT status, reviewed_at FROM deposit_requests WHERE id = $1 FOR UPDATE", [request.id]
  );
  assert.deepEqual(pending, { status: "pending", reviewed_at: null });
  for (const sql of [
    "SELECT id FROM ledger_transactions WHERE id = $1",
    "SELECT transaction_id FROM ledger_entries WHERE transaction_id = $1"
  ]) {
    assert.equal((await pool.query(sql, [discardedJournal.transactionId])).rowCount, 0);
  }
  assert.deepEqual(await displayedBalances(owner), Array(3).fill("0.00000000"));

  const recovered = await approveSimulatedClaim(request.id, observed);
  const replay = await approveSimulatedClaim(request.id, observed);
  assert.equal(recovered.idempotent, false);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.transactionId, recovered.transactionId);
  const { rows: [review] } = await pool.query("SELECT status FROM deposit_requests WHERE id = $1", [request.id]);
  assert.equal(review.status, "approved");
  assert.deepEqual(await displayedBalances(owner), ["25.00000000", "0.00000000", "0.00000000"]);
});

for (const finish of ["disconnect", "commit"]) {
  test(`waiting simulated worker recovers after first worker's ${finish}`, { skip: !enabled }, async () => {
    const owner = await createSimulationWallet(finish === "commit" ? 507 : 508);
    const event = `test-chain:waiting-worker:${finish}`;
    const observed = new Map([[event, { userId: owner, amount: "25" }]]);
    const { rows: [request] } = await pool.query(
      "INSERT INTO deposit_requests (user_id, amount, transfer_event) VALUES ($1, 25, $2) RETURNING id",
      [owner, event]
    );
    const first = await pool.connect();
    let waiting;
    let journal;
    try {
      await first.query("BEGIN");
      journal = await reviewSimulatedClaim(first, request.id, observed);
      let waiterPid;
      waiting = withLedgerTransaction(pool, async second => {
        waiterPid = second.processID;
        return reviewSimulatedClaim(second, request.id, observed);
      });
      // Observe the actual lock dependency before releasing the first worker.
      // Install a rejection handler immediately in case the second connection fails.
      const blocked = async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (waiterPid) {
            const { rows: [row] } = await pool.query(
              "SELECT $1::int = ANY(pg_blocking_pids($2)) AS blocked", [first.processID, waiterPid]
            );
            if (row.blocked) return;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail("Second worker did not block on the first worker");
      };
      await Promise.race([waiting.then(() => assert.fail("Second worker finished before lock release")), blocked()]);
      if (finish === "commit") await first.query("COMMIT");
    } finally {
      first.release(true);
      if (waiting) await waiting;
    }
    const recovered = await waiting;
    assert.equal(recovered.idempotent, finish === "commit");
    assert.equal(recovered.transactionId === journal.transactionId, finish === "commit");
    assert.deepEqual(await displayedBalances(owner), ["25.00000000", "0.00000000", "0.00000000"]);
    assert.deepEqual(await findSimulationDiscrepancies(pool, simulationClearing), []);
  });
}
