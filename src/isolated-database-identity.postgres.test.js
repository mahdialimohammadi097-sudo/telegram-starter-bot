import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { isolatedDatabaseIdentitySql, isIsolatedDatabaseIdentity } from "./isolated-database-identity.js";

const url = process.env.CATALOG_REHEARSAL_URL;
function safeTarget() {
  return isDisposablePostgresTarget(url, "catalog_rehearsal");
}

test("PostgreSQL 17 distinguishes session markers from an independently marked test database", { skip: !safeTarget(), timeout: 20000 }, async () => {
  // Only the explicitly disposable CI service; never change an existing database marker.
  const name = "profino_test_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  let created = false;
  let sandbox;
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    const target = new URL(url);
    target.pathname = "/" + name;
    sandbox = new pg.Client({ connectionString: target.toString(), connectionTimeoutMillis: 5000 });
    await sandbox.connect();
    await sandbox.query("SELECT set_config('profino.environment', 'isolated-staging', false)");
    let { rows: [row] } = await sandbox.query(isolatedDatabaseIdentitySql);
    assert.equal(row.environment, "isolated-staging");
    assert.equal(row.database_marker, false);
    assert.equal(isIsolatedDatabaseIdentity(row, name), false);
    await sandbox.end();
    sandbox = undefined;
    await admin.query('ALTER DATABASE "' + name + '" SET profino.environment = \'isolated-staging\'');
    sandbox = new pg.Client({ connectionString: target.toString(), connectionTimeoutMillis: 5000 });
    await sandbox.connect();
    ({ rows: [row] } = await sandbox.query(isolatedDatabaseIdentitySql));
    assert.equal(row.database_marker, true);
    assert.equal(isIsolatedDatabaseIdentity(row, name), true);
  } finally {
    try {
      if (sandbox) await sandbox.end();
    } finally {
      try { if (created) await admin.query('DROP DATABASE "' + name + '"'); }
      finally { await admin.end(); }
    }
  }
});
