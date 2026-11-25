import test from "node:test";
import assert from "node:assert/strict";
import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";

test("database test opt-in requires an explicitly named local disposable service", () => {
  const env = { PROFINO_DISPOSABLE_POSTGRES: "yes" };
  for (const scheme of ["postgres", "postgresql"]) {
    for (const host of ["localhost", "127.0.0.1"]) {
      for (const db of ["profino_test", "catalog_rehearsal"]) {
        const url = scheme + "://" + host + ":5432/" + db;
        assert.equal(isDisposablePostgresTarget(url, db, env), true);
        assert.equal(isDisposablePostgresTarget(url, db, {}), false);
      }
    }
  }
  for (const url of [
    undefined, null, "", "not-a-url",
    "https://localhost/profino_test",
    "postgresql://production.invalid/profino_test",
    "postgresql://localhost/profino-db",
    "postgresql://localhost/catalog_rehearsal",
    "postgresql://localhost/profino_test?host=production.invalid",
    "postgresql://localhost/profino_test?dbname=production",
    "postgresql://localhost/profino_test?",
    "postgresql://localhost/profino_test#fragment",
    "postgresql://localhost/profino_test/extra",
    "postgresql://localhost/other/../profino_test",
    "postgresql://localhost/other/%2e%2e/profino_test",
    "postgresql://%6cocalhost/profino_test",
    "postgresql://127.1/profino_test",
    "postgresql://localhost:5432/profino_test?options=-c%20search_path=public",
    " postgresql://localhost/profino_test",
    "postgresql://localhost/profino_test\n"
  ]) assert.equal(isDisposablePostgresTarget(url, "profino_test", env), false);
  assert.equal(isDisposablePostgresTarget("postgresql://localhost/profino-db", "profino-db", env), false);
});
