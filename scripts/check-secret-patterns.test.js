import test from "node:test";
import assert from "node:assert/strict";
import { detectSecretKinds } from "./check-secret-patterns.js";

test("detects synthetic credential shapes without returning their values", () => {
  const cases = [
    ["private-key", ["-----BEGIN ", "OPENSSH PRIVATE KEY-----"].join("")],
    ["github-token", "ghp_" + "X".repeat(36)],
    ["telegram-token", "123456789:" + "A".repeat(35)],
    ["database-url", "postgresql://" + "tester:" + "random-fixture" + "@localhost/db"]
  ];
  for (const [kind, fixture] of cases) assert.deepEqual(detectSecretKinds(fixture), [kind]);
});

test("allows documented placeholders and environment variable references", () => {
  assert.deepEqual(detectSecretKinds("process.env.BOT_TOKEN"), []);
  assert.deepEqual(detectSecretKinds("postgresql://user:password@localhost/database"), []);
  assert.deepEqual(detectSecretKinds("postgresql://user:<password>@localhost/database"), []);
});

test("repeat scans are stable and mixed matches are classified only once", () => {
  const value = "postgres://" + "tester:" + "fixture-secret" + "@localhost/db";
  for (let i = 0; i < 3; i++) assert.deepEqual(detectSecretKinds(value + "\n" + value), ["database-url"]);
});

test("does not match connection URL components across quoted source strings", () => {
  const urlPrefix = "postgresql://";
  const credentials = "test-user:synthetic-secret@127.0.0.1:1/db";
  const source = JSON.stringify([urlPrefix, credentials]) + ".join('')";
  assert.deepEqual(detectSecretKinds(source), []);
  assert.deepEqual(detectSecretKinds(urlPrefix + credentials), ["database-url"]);
  assert.deepEqual(detectSecretKinds(urlPrefix + "user:encoded%40secret@localhost/db"), ["database-url"]);
});
