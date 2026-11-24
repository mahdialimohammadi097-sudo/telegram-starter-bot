import { withLedgerTransaction } from "./ledger-posting.js";
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


function makePostingPool({ balance = "10.00000000", statusUpdateRowCount = 1, entryInsertRowCount = 1, rollbackError = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized === "ROLLBACK" && rollbackError) {
        throw rollbackError;
      }
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { command: normalized, rowCount: 0, rows: [] };
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
        return { rowCount: entryInsertRowCount, rows: [] };
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
        return { command: normalized, rowCount: 0, rows: [] };
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

test("rejects unsafe and out-of-range ledger identifiers", () => {
  const entries = id => [
    { account_id: id, entry_type: "debit", amount: "1", currency: "USDT" },
    { account_id: "2", entry_type: "credit", amount: "1", currency: "USDT" }
  ];
  assert.throws(() => normalizeEntries(entries(Number.MAX_SAFE_INTEGER + 1)), /Unsafe numeric ledger account id/);
  assert.throws(() => normalizeEntries(entries("9223372036854775808")), /Invalid ledger account id/);
  assert.throws(() => normalizeEntries(entries("1".repeat(100))), /Invalid ledger account id/);
  assert.equal(normalizeEntries(entries("9223372036854775807"))[0].account_id, "9223372036854775807");
});

test("failed BEGIN discards the connection without invoking the transaction callback", async () => {
  const failure = new Error("BEGIN response lost");
  const calls = [];
  const pool = { async connect() { return {
    async query(sql) { calls.push(sql); throw failure; },
    release(error) { calls.push(error); }
  }; } };
  await assert.rejects(withLedgerTransaction(pool, async () => { assert.fail("callback must not run"); }), error => error === failure);
  assert.deepEqual(calls, ["BEGIN", failure]);
});

test("failed rollback preserves a frozen original error and discards the connection", async () => {
  const original = Object.freeze(new Error("operation failed"));
  const rollbackFailure = new Error("rollback failed");
  const calls = [];
  const pool = { async connect() { return {
    async query(sql) { calls.push(sql); if (sql === "ROLLBACK") throw rollbackFailure; return { command: sql }; },
    release(error) { calls.push(error); }
  }; } };
  await assert.rejects(withLedgerTransaction(pool, async () => { throw original; }), error => error === original);
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK", rollbackFailure]);
});

test("a rollback command tag cannot masquerade as a successful ledger commit", async () => {
  const calls = [];
  const pool = { async connect() { return {
    async query(sql) { calls.push(sql); return { command: sql === "COMMIT" ? "ROLLBACK" : sql }; },
    release(error) { calls.push(["release", Boolean(error)]); }
  }; } };
  await assert.rejects(withLedgerTransaction(pool, async () => ({ posted: true })), /rolled back instead of committed/);
  assert.deepEqual(calls, ["BEGIN", "COMMIT", ["release", true]]);
});

test("a skipped ledger entry insert rolls back rather than marking a journal posted", async () => {
  const { pool, calls } = makePostingPool({ entryInsertRowCount: 0 });
  const { postLedgerTransaction } = await import("./ledger-posting.js");
  await assert.rejects(postLedgerTransaction({
    pool, transactionType: "internal_transfer", idempotencyKey: "skipped-entry-fixture",
    entries: [
      { account_id: "1", entry_type: "debit", amount: "2", currency: "USDT" },
      { account_id: "2", entry_type: "credit", amount: "2", currency: "USDT" }
    ]
  }), /did not create exactly one row/);
  assert.ok(!calls.some(call => call.sql.startsWith("UPDATE ledger_transactions")));
  assert.equal(calls.at(-2).sql, "ROLLBACK");
});

for (const response of [undefined, null, {}, {command:"SELECT"}, [{command:"COMMIT"}]]) {
 test("rejects ambiguous BEGIN response: "+JSON.stringify(response),async()=>{
  let invoked=false,discard;
  const calls=[];
  const pool={connect:async()=>({query:async sql=>{calls.push(sql);return response;},release(error){discard=error;}})};
  await assert.rejects(withLedgerTransaction(pool,async()=>{invoked=true;}),/start unconfirmed/);
  assert.equal(invoked,false);
  assert.deepEqual(calls,["BEGIN"]);
  assert.ok(discard instanceof Error);
 });
 test("rejects ambiguous COMMIT response: "+JSON.stringify(response),async()=>{
  const calls=[];let discard;
  const pool={connect:async()=>({query:async sql=>{calls.push(sql);return sql==="BEGIN"?{command:"BEGIN"}:response;},release(error){discard=error;}})};
  await assert.rejects(withLedgerTransaction(pool,async()=>({posted:true})),/commit unconfirmed/);
  assert.deepEqual(calls,["BEGIN","COMMIT"]);
  assert.ok(discard instanceof Error);
 });
}
