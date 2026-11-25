import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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
  assert.equal(result.findingObjects.length, 1);
  assert.equal(result.findingObjects[0].kind, "github-token");
  assert.match(result.findingObjects[0].oid, /^[a-f0-9]{40,64}$/);
  assert.deepEqual(Object.keys(result.findingObjects[0]).sort(), ["kind", "oid"]);
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


test("reviewed historical CI blob does not exempt modified credentials", t => {
  const cwd=mkdtempSync(join(tmpdir(),"profino-reviewed-history-"));
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  const git=(...args)=>execFileSync("git",args,{cwd,stdio:"pipe"});
  git("init");
  git("config","user.name","Fixture");
  git("config","user.email","fixture@example.invalid");
  const original=readFileSync(new URL("../.github/workflows/standalone-security-postgres.yml",import.meta.url),"utf8");
  const filename=join(cwd,"fixture.yml");
  writeFileSync(filename,original);
  git("add",".");
  git("commit","-m","reviewed local CI fixture");
  assert.equal(git("rev-parse","HEAD:fixture.yml").toString().trim(),"b26955a6da747ee12d9c2d05058faac58a19fc75");
  const reviewed=scanHistory(cwd);
  assert.equal(reviewed.findings.size,0);
  assert.equal(reviewed.reviewed,1);
  const modified=original.replace("@localhost:5432/profino_security_rehearsal","@remote.invalid:5432/profino_security_rehearsal");
  assert.notEqual(modified,original);
  writeFileSync(filename,modified);
  git("add",".");
  git("commit","-m","unreviewed synthetic remote fixture");
  const result=scanHistory(cwd);
  assert.equal(result.reviewed,1);
  assert.equal(result.findings.get("database-url"),1);
  assert.equal(result.findingObjects.length,1);
  assert.notEqual(result.findingObjects[0].oid,"b26955a6da747ee12d9c2d05058faac58a19fc75");
});
