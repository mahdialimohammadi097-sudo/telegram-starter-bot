import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const source = new URL("./database.js", import.meta.url).href;
function inspect(mode) {
  const script = `import { pool } from ${JSON.stringify(source)}; console.log(JSON.stringify(pool.options.ssl)); await pool.end();`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "postgres://user:pass@localhost:5432/test",
      ...(mode === undefined ? { PROFINO_DATABASE_TLS: "" } : { PROFINO_DATABASE_TLS: mode }) }
  });
}

test("private-network default retains existing TLS-disabled behavior", () => {
  const result = inspect(undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()), false);
});

test("TLS verification is opt-in and validates certificates", () => {
  const result = inspect("verify");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { rejectUnauthorized: true });
});

test("unknown TLS configuration fails closed", () => {
  const result = inspect("insecure");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PROFINO_DATABASE_TLS must be disabled or verify/);
});
