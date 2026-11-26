import test from "node:test";
import assert from "node:assert/strict";
import { simulationRequestKey } from "./simulation-request-key.js";

test("same user and message replay yields the same idempotency key", () => {
  assert.equal(simulationRequestKey("telegram-preview", 123, 77), simulationRequestKey("telegram-preview", "123", "77"));
  assert.equal(simulationRequestKey("telegram-withdraw", 123, 77), simulationRequestKey("telegram-withdraw", 123, 77));
});

test("distinct users cannot collide when Telegram message IDs match", () => {
  for (const kind of ["telegram-preview", "telegram-withdraw"]) {
    assert.notEqual(simulationRequestKey(kind, 123, 77), simulationRequestKey(kind, 456, 77));
    assert.notEqual(simulationRequestKey(kind, 123, 77), simulationRequestKey(kind, 123, 78));
  }
});

test("investment and withdrawal namespaces remain isolated", () => {
  assert.notEqual(simulationRequestKey("telegram-preview", 123, 77), simulationRequestKey("telegram-withdraw", 123, 77));
});

test("invalid request key identifiers are rejected", () => {
  for (const value of [0, -1, "1:2", "", "abc", null]) {
    assert.throws(() => simulationRequestKey("telegram-preview", value, 77), TypeError);
  }
  assert.throws(() => simulationRequestKey("other", 123, 77), TypeError);
});

test("rejects ambiguous and out-of-range identities in both key positions", () => {
  for (const id of [Number.MAX_SAFE_INTEGER + 1, "9223372036854775808", "9".repeat(10000), ["12"], {toString: () => "12"}, "012", 1.5, true]) {
    assert.throws(() => simulationRequestKey("telegram-preview", id, 34), TypeError);
    assert.throws(() => simulationRequestKey("telegram-preview", 12, id), TypeError);
  }
  assert.equal(simulationRequestKey("telegram-preview", "9223372036854775807", 34n),
    simulationRequestKey("telegram-preview", 9223372036854775807n, "34"));
});
