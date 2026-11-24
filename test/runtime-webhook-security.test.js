import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const guard = source.slice(source.indexOf("const webhookSecret ="), source.indexOf("const bot = new Bot(token);"));

function evaluate(mode, secret) {
  const context = { mode, process: { env: { WEBHOOK_SECRET: secret }, exit() { throw new Error("rejected"); } }, console: { error() {} } };
  return vm.runInNewContext(guard + "\nwebhookSecret", context);
}

test("webhook startup rejects missing or invalid secrets", () => {
  for (const secret of [undefined, "", "   ", "bad secret", "a".repeat(257), "bad/secret"]) {
    assert.throws(() => evaluate("webhook", secret), /rejected/);
  }
});

test("valid webhook secret accepted; polling needs no secret", () => {
  assert.equal(evaluate("webhook", "valid_secret-123"), "valid_secret-123");
  assert.equal(evaluate("polling", undefined), "");
});

test("runtime diagnostic formatter never returns raw error messages", () => {
  const format = vm.runInNewContext(guard + "\nsafeErrorCode", { mode: "polling", process: { env: {} } });
  assert.equal(format({ message: "sensitive-token", code: "sensitive-code" }), "operation_failed");
  assert.equal(format({ error_code: 401 }), 401);
  assert.equal(format(null), "operation_failed");
});

test("same validated secret is passed to webhook callback and registration", () => {
  assert.match(source, /const secret = webhookSecret;/);
  assert.match(source, /secretToken: secret/);
  assert.match(source, /secret_token: secret/);
});
