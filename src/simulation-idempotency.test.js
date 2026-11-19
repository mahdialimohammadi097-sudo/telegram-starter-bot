import test from "node:test";
import assert from "node:assert/strict";
import { simulationRequestKey } from "./simulation-idempotency.js";

test("same customer and Telegram message retries share one key", () => {
  assert.equal(simulationRequestKey("investment", 12, 34), simulationRequestKey("investment", "12", "34"));
});

test("identical Telegram message IDs across customers cannot collide", () => {
  assert.notEqual(simulationRequestKey("investment", 12, 34), simulationRequestKey("investment", 13, 34));
  assert.notEqual(simulationRequestKey("withdrawal", 12, 34), simulationRequestKey("withdrawal", 13, 34));
});

test("investment and withdrawal operations cannot share idempotency keys", () => {
  assert.notEqual(simulationRequestKey("investment", 12, 34), simulationRequestKey("withdrawal", 12, 34));
});

test("malformed identifiers and unsupported operations fail closed", () => {
  for (const args of [["deposit", 12, 34], ["investment", 0, 34], ["withdrawal", 12, -1], ["investment", "12:34", 1], ["investment", 12, "3:4"]]) {
    assert.throws(() => simulationRequestKey(...args));
  }
});

test("unsafe JavaScript numeric IDs are rejected instead of silently rounding", () => {
  assert.throws(() => simulationRequestKey("investment", Number.MAX_SAFE_INTEGER + 1, 10), /Unsafe numeric/);
  assert.throws(() => simulationRequestKey("withdrawal", 10, Number.MAX_SAFE_INTEGER + 1), /Unsafe numeric/);
  assert.equal(simulationRequestKey("investment", "9007199254740993", "10"), "telegram-investment:9007199254740993:10");
});
