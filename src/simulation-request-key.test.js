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
