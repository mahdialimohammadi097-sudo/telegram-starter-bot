import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanHistory } from "./check-secret-history.js";

test("history scan detects a removed synthetic credential without returning its value", t => {
  const cwd = mkdtempSync(join(tmpdir(), "profino-history-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const filename = join(cwd, "fixture.txt");
  writeFileSync(filename, "ghp_" + "X".repeat(36));
  git("add", ".");
  git("commit", "-m", "synthetic credential");
  writeFileSync(filename, "removed");
  git("add", ".");
  git("commit", "-m", "remove synthetic credential");
  const result = scanHistory(cwd);
  assert.equal(result.scanned, 2);
  assert.equal(result.findings.get("github-token"), 1);
  assert.equal(result.findings.size, 1);
  assert.equal(result.reviewed, 0);
});

test("history scan rejects shallow repositories rather than claiming complete coverage", t => {
  const root = mkdtempSync(join(tmpdir(), "profino-shallow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin"), shallow = join(root, "shallow");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git(root, "init", origin);
  git(origin, "config", "user.name", "Fixture");
  git(origin, "config", "user.email", "fixture@example.invalid");
  git(origin, "commit", "--allow-empty", "-m", "first");
  git(origin, "commit", "--allow-empty", "-m", "second");
  git(root, "clone", "--depth=1", "file://" + origin, shallow);
  assert.throws(() => scanHistory(shallow), /Full history required/);
});
