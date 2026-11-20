import test from "node:test";
import assert from "node:assert/strict";
import { safeDiagnosticCode } from "./diagnostic-safety.js";

test("allows a valid five-character SQLSTATE code", () => {
  assert.equal(safeDiagnosticCode({ code: "42P01" }), "42P01");
});

test("hides arbitrary driver text and connection credentials", () => {
  assert.equal(
    safeDiagnosticCode({ message: "postgres://admin:secret@db.internal/prod" }),
    "UNAVAILABLE"
  );
  assert.equal(safeDiagnosticCode({ code: "42P01 password=secret" }), "UNAVAILABLE");
  assert.equal(safeDiagnosticCode(null), "UNAVAILABLE");
});
