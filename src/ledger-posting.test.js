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
