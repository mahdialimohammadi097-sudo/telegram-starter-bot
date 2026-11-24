import test from "node:test";
import assert from "node:assert/strict";
import { safeDiagnosticCode, safeTelegramDiagnosticCode } from "./diagnostic-safety.js";

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

test("Telegram diagnostics allow only HTTP-style error integers", () => {
  for (const code of [400, 401, 403, 429, 500, 599]) assert.equal(safeTelegramDiagnosticCode({ error_code: code }), code);
  for (const code of [undefined, null, "429", "private fixture credential", { secret: "fixture" }, 399, 600, 429.5, 123456789]) {
    assert.equal(safeTelegramDiagnosticCode({ error_code: code }), "UNAVAILABLE");
  }
  assert.equal(safeTelegramDiagnosticCode(null, "telegram_send_failed"), "telegram_send_failed");
});
