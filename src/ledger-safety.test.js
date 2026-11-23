import test from "node:test";
import assert from "node:assert/strict";
import { formatUsdt, toUsdtUnits, toUsdtUnitsExact, assertBalancedLedgerEntries, assertNonNegativeAvailableBalance } from "./ledger-safety.js";

test("USDT formatting preserves eight-decimal precision", () => {
  assert.equal(formatUsdt("0.00000001"), "0.00000001");
  assert.equal(formatUsdt("123456789.12345678"), "123456789.12345678");
  assert.equal(formatUsdt("1.123456785"), "1.12345679");
  assert.equal(toUsdtUnits("2.5"), 250000000n);
});

test("exact financial parsing rejects precision beyond eight decimals", () => {
  assert.equal(toUsdtUnitsExact("1.12345678"), 112345678n);
  assert.equal(toUsdtUnitsExact("0.00000001"), 1n);
  assert.throws(() => toUsdtUnitsExact("1.000000001"), /exceeds eight decimal places/);
  assert.throws(() => toUsdtUnitsExact("1.123456785"), /exceeds eight decimal places/);
});

test("ledger entries must balance per currency without rounding", () => {
  assert.equal(assertBalancedLedgerEntries([
    { currency: "USDT", entry_type: "debit", amount: "12.5" },
    { currency: "USDT", entry_type: "credit", amount: "12.50000000" }
  ]), true);
  assert.throws(() => assertBalancedLedgerEntries([
    { currency: "USDT", entry_type: "debit", amount: "12.5" },
    { currency: "USDT", entry_type: "credit", amount: "12.4" }
  ]), /Unbalanced/);
  assert.throws(() => assertBalancedLedgerEntries([
    { currency: "USDT", entry_type: "debit", amount: "1.000000001" },
    { currency: "USDT", entry_type: "credit", amount: "1" }
  ]), /exceeds eight decimal places/);
});

test("ledger balancing is isolated by currency", () => {
  assert.throws(() => assertBalancedLedgerEntries([
    { currency: "USDT", entry_type: "debit", amount: "1" },
    { currency: "USDC", entry_type: "credit", amount: "1" }
  ]), /Unbalanced/);
});

test("ledger entries reject invalid or non-positive amounts", () => {
  assert.throws(() => assertBalancedLedgerEntries([
    { currency: "USDT", entry_type: "debit", amount: "0" },
    { currency: "USDT", entry_type: "credit", amount: "0" }
  ]), /Invalid ledger entry/);
  assert.throws(() => toUsdtUnits("1e-8"), /Invalid USDT amount/);
});

test("available balance cannot be overdrawn or rounded", () => {
  assert.equal(assertNonNegativeAvailableBalance("10.00000000", "9.99999999"), true);
  assert.throws(() => assertNonNegativeAvailableBalance("10", "10.00000001"), /Insufficient/);
  assert.throws(() => assertNonNegativeAvailableBalance("0", "0"), /Insufficient/);
  assert.throws(() => assertNonNegativeAvailableBalance("1.000000001", "1"), /exceeds eight decimal places/);
});

test("financial parser rejects imprecise JavaScript numeric amounts", () => {
  assert.throws(() => toUsdtUnitsExact(0.1), /exact decimal string/);
  assert.throws(() => toUsdtUnitsExact(9007199254740992), /exact decimal string/);
  assert.throws(() => toUsdtUnitsExact(Number.POSITIVE_INFINITY), /exact decimal string/);
  assert.equal(toUsdtUnitsExact("0.1"), 10000000n);
  assert.equal(toUsdtUnitsExact("9007199254740992"), 900719925474099200000000n);
  assert.equal(toUsdtUnitsExact(10), 1000000000n);
});

test("financial amounts respect PostgreSQL numeric(36,18) capacity", () => {
  assert.equal(toUsdtUnitsExact("999999999999999999.99999999"), 10n ** 26n - 1n);
  assert.throws(() => toUsdtUnitsExact("1000000000000000000"), /ledger numeric capacity/);
  assert.throws(() => toUsdtUnitsExact("-1000000000000000000"), /ledger numeric capacity/);
  assert.throws(() => assertBalancedLedgerEntries([
    { currency: "USDT", entry_type: "debit", amount: "1000000000000000000" },
    { currency: "USDT", entry_type: "credit", amount: "1000000000000000000" }
  ]), /ledger numeric capacity/);
});
