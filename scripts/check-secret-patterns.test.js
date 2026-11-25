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

test("only known disposable database URLs and local placeholders are exempt", () => {
  const prefix = "postgresql://";
  assert.deepEqual(detectSecretKinds(prefix + "postgres:postgres@localhost:5432/profino_test"), []);
  assert.deepEqual(detectSecretKinds(prefix + "postgres:postgres@remote.invalid:5432/profino_test"), ["database-url"]);
  assert.deepEqual(detectSecretKinds(prefix + "user:password@remote.invalid/db"), ["database-url"]);
  assert.deepEqual(detectSecretKinds(prefix + "postgres:postgres@localhost:5432/production"), ["database-url"]);
});
test("Telegram credential detection includes a trailing hyphen", () => {
  assert.deepEqual(detectSecretKinds("123456789:" + "A".repeat(34) + "-"), ["telegram-token"]);
});

test("reviewed disposable credentials are exempt only in the exact workflow path", () => {
  const prefix = "postgresql://";
  const url = prefix + "postgres:rehearsal@localhost:5432/catalog_rehearsal";
  const workflow = ".github/workflows/catalog-owner-postgres.yml";
  assert.deepEqual(detectSecretKinds(url, workflow), []);
  assert.deepEqual(detectSecretKinds(url, "src/production.js"), ["database-url"]);
  assert.deepEqual(detectSecretKinds(url + "\n" + prefix + "postgres:rehearsal@remote.invalid:5432/catalog_rehearsal", workflow), ["database-url"]);
  assert.deepEqual(detectSecretKinds(prefix + "postgres:other-secret@localhost:5432/catalog_rehearsal", workflow), ["database-url"]);
});
