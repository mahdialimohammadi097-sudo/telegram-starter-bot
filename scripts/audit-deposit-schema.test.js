import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./audit-deposit-schema.js", import.meta.url));
function run(args, env = {}) {
  // No inherited database connection or credentials; reject inputs before connecting.
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 10000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 3);
  assert.equal(result.stdout, "");
  const report=JSON.parse(result.stderr);
  assert.equal(report.financialActivationReady,false);
  assert.equal(report.realDepositsEnabled,false);
  return report;
}

test("default deposit audit retains its failure report when no DSN is supplied", () => {
  const report = run([]);
  assert.equal(report.audit, "deposit-schema");
  assert.equal(report.ready, false);
});

test("combined audit fails closed when connection configuration is missing", () => {
  const report = run(["--include-legacy-assignments"]);
  assert.equal(report.audit, "combined-deposit-preflight");
  assert.equal(report.ready, false);
  assert.equal(report.realDepositsEnabled, false);
});

test("unsupported arguments are refused without exposing input", () => {
  const marker = "synthetic-sensitive-argument";
  const report = run(["--include-legacy-assignments", marker]);
  assert.equal(report.ready, false);
  assert.ok(!JSON.stringify(report).includes(marker));
});

test("combined audit refuses ambiguous TLS configuration without printing DSN", () => {
  const marker = "synthetic-invalid-url";
  const report = run(["--include-legacy-assignments"], { DATABASE_URL: marker });
  assert.equal(report.ready, false);
  assert.equal(report.realDepositsEnabled, false);
  assert.ok(!JSON.stringify(report).includes(marker));
});
