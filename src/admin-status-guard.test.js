import test from "node:test";
import assert from "node:assert/strict";
import { isConfirmationCurrent } from "./admin-status-guard.js";

test("accepts a confirmation when the user's status is unchanged", () => {
  assert.equal(isConfirmationCurrent("active", "active", "blocked"), true);
});

test("rejects a confirmation after the user's status changed", () => {
  assert.equal(isConfirmationCurrent("blocked", "active", "blocked"), false);
});

test("rejects a confirmation that requests the current status", () => {
  assert.equal(isConfirmationCurrent("active", "active", "active"), false);
});

test("rejects unknown statuses", () => {
  assert.equal(isConfirmationCurrent("deleted", "deleted", "active"), false);
});

test("accepts pending accounts for an admin activation confirmation", () => {
  assert.equal(isConfirmationCurrent("pending", "pending", "active"), true);
});

test("all supported status transitions require a real change", () => {
  for (const current of ["active", "blocked", "pending"]) {
    for (const next of ["active", "blocked", "pending"]) {
      assert.equal(isConfirmationCurrent(current, current, next), current !== next);
    }
  }
});
test("all stale status confirmations fail closed", () => {
  for (const current of ["active", "blocked", "pending"]) {
    for (const previous of ["active", "blocked", "pending"]) {
      if (current === previous) continue;
      assert.equal(isConfirmationCurrent(current, previous, "active"), false);
    }
  }
});
test("invalid status in any position cannot authorize a transition", () => {
  for (const value of ["", "owner", "deleted", "ACTIVE", null, undefined]) {
    assert.equal(isConfirmationCurrent(value, "active", "blocked"), false);
    assert.equal(isConfirmationCurrent("active", value, "blocked"), false);
    assert.equal(isConfirmationCurrent("active", "active", value), false);
  }
});
