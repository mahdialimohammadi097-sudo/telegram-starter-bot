import test from "node:test";
import assert from "node:assert/strict";
import { safeDiagnosticCode } from "./diagnostic-safety.js";

test("preserves a valid five-character database diagnostic code", () => {
  assert.equal(safeDiagnosticCode({ code: "23505" }), "23505");
  assert.equal(safeDiagnosticCode({ code: "ABCDE" }), "ABCDE");
});

test("hides malformed and missing diagnostic codes", () => {
  for (const error of [
    null,
    undefined,
    {},
    { code: "secret connection string" },
    { code: "23505\npassword=secret" },
    { code: "abcd" },
    { code: "123456" }
  ]) {
    assert.equal(safeDiagnosticCode(error), "UNAVAILABLE");
  }
});
