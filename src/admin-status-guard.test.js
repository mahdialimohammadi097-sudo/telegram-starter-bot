import test from "node:test";
import assert from "node:assert/strict";
import { isConfirmationCurrent } from "./admin-status-guard.js";

test("accepts a confirmation when the user's status is unchanged", () => {
  assert.equal(isConfirmationCurrent("active", "active", "suspended"), true);
});

test("rejects a confirmation after the user's status changed", () => {
  assert.equal(isConfirmationCurrent("suspended", "active", "suspended"), false);
});

test("rejects a confirmation that requests the current status", () => {
  assert.equal(isConfirmationCurrent("active", "active", "active"), false);
});

test("rejects unknown statuses", () => {
  assert.equal(isConfirmationCurrent("deleted", "deleted", "active"), false);
});
