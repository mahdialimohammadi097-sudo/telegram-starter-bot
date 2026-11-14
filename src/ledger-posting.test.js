import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEntries, canonicalEntries } from "./ledger-posting.js";

test("normalizes USDT entries to exact eight-decimal strings", () => {
  const entries = normalizeEntries([
    { account_id: "12", entry_type: "debit", amount: "1.25", currency: "usdt" },
    { account_id: 13, entry_type: "credit", amount: "1.25000000", currency: "USDT" }
  ]);
  assert.equal(entries[0].amount, "1.25000000");
  assert.equal(entries[1].amount, "1.25000000");
});

test("rejects non-USDT, invalid account ids and excessive precision", () => {
  assert.throws(() => normalizeEntries([
    { account_id: "1", entry_type: "debit", amount: "1", currency: "USDC" },
    { account_id: "2", entry_type: "credit", amount: "1", currency: "USDC" }
  ]), /Only USDT/);
  assert.throws(() => normalizeEntries([
    { account_id: "0", entry_type: "debit", amount: "1", currency: "USDT" },
    { account_id: "2", entry_type: "credit", amount: "1", currency: "USDT" }
  ]), /account id/);
  assert.throws(() => normalizeEntries([
    { account_id: "1", entry_type: "debit", amount: "1.000000001", currency: "USDT" },
    { account_id: "2", entry_type: "credit", amount: "1.000000001", currency: "USDT" }
  ]), /eight decimal places/);
});

test("rejects unbalanced entries", () => {
  assert.throws(() => normalizeEntries([
    { account_id: "1", entry_type: "debit", amount: "2", currency: "USDT" },
    { account_id: "2", entry_type: "credit", amount: "1", currency: "USDT" }
  ]), /Unbalanced/);
});

test("canonical request comparison is independent of entry order", () => {
  const a = [
    { account_id: "2", entry_type: "credit", amount: "3.5", currency: "USDT" },
    { account_id: "1", entry_type: "debit", amount: "3.50000000", currency: "USDT" }
  ];
  const b = [...a].reverse();
  assert.deepEqual(canonicalEntries(a), canonicalEntries(b));
});


function makePostingPool({ balance = "10.00000000", statusUpdateRowCount = 1, rollbackError = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized === "ROLLBACK" && rollbackError) {
        throw rollbackError;
      }
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (normalized.includes("pg_advisory_xact_lock")) {
        return { rowCount: 1, rows: [] };
      }
      if (normalized.includes("FROM ledger_transactions") &&
          normalized.includes("idempotency_key = $1")) {
        return { rowCount: 0, rows: [] };
      }
      if (normalized.includes("FROM ledger_accounts")) {
        return {
          rowCount: 2,
          rows: [
            { id: "1", account_type: "AVAILABLE", currency: "USDT" },
            { id: "2", account_type: "CLEARING", currency: "USDT" }
          ]
        };
      }
      if (normalized.includes("FROM ledger_entries le") &&
          normalized.includes("lt.status = 'posted'")) {
        return { rowCount: 1, rows: [{ balance }] };
      }
      if (normalized.startsWith("INSERT INTO ledger_transactions")) {
        return { rowCount: 1, rows: [{ id: "77" }] };
      }
      if (normalized.startsWith("INSERT INTO ledger_entries")) {
        return { rowCount: 1, rows: [] };
      }
      if (normalized.startsWith("UPDATE ledger_transactions")) {
        return { rowCount: statusUpdateRowCount, rows: [] };
      }
      throw new Error("Unexpected SQL in test: " + normalized);
    },
    release(error) {
      calls.push({ sql: "RELEASE", params: [], releaseError: error?.message ?? null });
    }
  };
  return {
    calls,
    pool: { async connect() { return client; } }
  };
}

test("posts a balanced journal atomically and releases the client", async () => {
  const { pool, calls } = makePostingPool({ balance: "5.00000000" });
  const { postLedgerTransaction } = await import("./ledger-posting.js");
  const result = await postLedgerTransaction({
    pool,
    transactionType: "internal_transfer",
    referenceId: 123,
    idempotencyKey: "test-transfer-001",
    description: "test only",
    entries: [
      { account_id: "1", entry_type: "debit", amount: "2", currency: "USDT" },
      { account_id: "2", entry_type: "credit", amount: "2", currency: "USDT" }
    ]
  });

  assert.deepEqual(result, {
    transactionId: "77",
    posted: true,
    idempotent: false
  });
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(calls.at(-1).sql, "RELEASE");
  assert.equal(calls.filter(call => call.sql.startsWith("INSERT INTO ledger_entries")).length, 2);
});

test("rolls back when an AVAILABLE account would become negative", async () => {
  const { pool, calls } = makePostingPool({ balance: "1.00000000" });
  const { postLedgerTransaction } = await import("./ledger-posting.js");

  await assert.rejects(
    postLedgerTransaction({
      pool,
      transactionType: "internal_transfer",
      idempotencyKey: "test-transfer-overdraft",
      entries: [
        { account_id: "1", entry_type: "debit", amount: "2", currency: "USDT" },
        { account_id: "2", entry_type: "credit", amount: "2", currency: "USDT" }
      ]
    }),
    /Insufficient available balance/
  );

  assert.equal(calls.at(-2).sql, "ROLLBACK");
  assert.equal(calls.at(-1).sql, "RELEASE");
  assert.equal(calls.some(call => call.sql.startsWith("INSERT INTO ledger_transactions")), false);
});


function makeExistingPostingPool({ transaction = {}, priorEntries = [] } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
        return { rowCount: 0, rows: [] };
      }
      if (normalized.includes("pg_advisory_xact_lock")) {
        return { rowCount: 1, rows: [] };
      }
      if (normalized.includes("FROM ledger_transactions") &&
          normalized.includes("idempotency_key = $1")) {
        return { rowCount: 1, rows: [{
          id: "77",
          transaction_type: "internal_transfer",
          reference_id: "123",
          description: "test only",
          status: "posted",
          ...transaction
        }] };
      }
      if (normalized.includes("FROM ledger_entries") &&
          normalized.includes("WHERE transaction_id = $1")) {
        return { rowCount: priorEntries.length, rows: priorEntries };
      }
      throw new Error("Unexpected SQL in idempotency test: " + normalized);
    },
    release() {
      calls.push({ sql: "RELEASE", params: [] });
    }
  };
  return { calls, pool: { async connect() { return client; } } };
}

test("returns an idempotent success for an identical posted request", async () => {
  const priorEntries = [
    { account_id: "1", entry_type: "debit", amount: "2.00000000", currency: "USDT" },
    { account_id: "2", entry_type: "credit", amount: "2.00000000", currency: "USDT" }
  ];
  const { pool, calls } = makeExistingPostingPool({ priorEntries });
  const { postLedgerTransaction } = await import("./ledger-posting.js");

  const result = await postLedgerTransaction({
    pool,
    transactionType: "internal_transfer",
    referenceId: 123,
    idempotencyKey: "test-transfer-existing",
    description: "test only",
    entries: [...priorEntries].reverse()
  });

  assert.deepEqual(result, {
    transactionId: "77",
    posted: true,
    idempotent: true
  });
  assert.equal(calls.some(call => call.sql.startsWith("INSERT INTO")), false);
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("rejects idempotency-key reuse when request metadata differs", async () => {
  const priorEntries = [
    { account_id: "1", entry_type: "debit", amount: "2.00000000", currency: "USDT" },
    { account_id: "2", entry_type: "credit", amount: "2.00000000", currency: "USDT" }
  ];
  const { pool, calls } = makeExistingPostingPool({
    priorEntries,
    transaction: { description: "a different request" }
  });
  const { postLedgerTransaction } = await import("./ledger-posting.js");

  await assert.rejects(
    postLedgerTransaction({
      pool,
      transactionType: "internal_transfer",
      referenceId: 123,
      idempotencyKey: "test-transfer-reused-key",
      description: "test only",
      entries: priorEntries
    }),
    /Idempotency key was already used for a different request/
  );

  assert.equal(calls.at(-2).sql, "ROLLBACK");
  assert.equal(calls.at(-1).sql, "RELEASE");
  assert.equal(calls.some(call => call.sql.startsWith("INSERT INTO")), false);
});


test("rolls back if the pending transaction cannot transition to posted", async () => {
  const { pool, calls } = makePostingPool({
    balance: "5.00000000",
    statusUpdateRowCount: 0
  });
  const { postLedgerTransaction } = await import("./ledger-posting.js");

  await assert.rejects(
    postLedgerTransaction({
      pool,
      transactionType: "internal_transfer",
      idempotencyKey: "test-transfer-missing-status-transition",
      entries: [
        { account_id: "1", entry_type: "debit", amount: "2", currency: "USDT" },
        { account_id: "2", entry_type: "credit", amount: "2", currency: "USDT" }
      ]
    }),
    /could not transition from pending to posted/
  );

  assert.equal(calls.at(-2).sql, "ROLLBACK");
  assert.equal(calls.at(-1).sql, "RELEASE");
  assert.equal(calls.some(call => call.sql === "COMMIT"), false);
});


test("discards the client when rollback fails and preserves the original posting error", async () => {
  const rollbackFailure = new Error("rollback connection failure");
  const { pool, calls } = makePostingPool({
    balance: "1.00000000",
    rollbackError: rollbackFailure
  });
  const { postLedgerTransaction } = await import("./ledger-posting.js");

  await assert.rejects(
    postLedgerTransaction({
      pool,
      transactionType: "internal_transfer",
      idempotencyKey: "test-rollback-client-discard",
      entries: [
        { account_id: "1", entry_type: "debit", amount: "2", currency: "USDT" },
        { account_id: "2", entry_type: "credit", amount: "2", currency: "USDT" }
      ]
    }),
    error => {
      assert.match(error.message, /Insufficient available balance/);
      assert.equal(error.rollbackError, rollbackFailure);
      return true;
    }
  );

  assert.equal(calls.at(-2).sql, "ROLLBACK");
  assert.equal(calls.at(-1).sql, "RELEASE");
  assert.equal(calls.at(-1).releaseError, "rollback connection failure");
});
