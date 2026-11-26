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
    // A caller-controlled search path must not falsify database identity or
    // turn an unrelated database-wide setting into the isolation marker.
    await admin.query('ALTER DATABASE "' + name + '" SET profino.environment = \'not-isolated\'');
    await sandbox.query("CREATE SCHEMA identity_shadow");
    await sandbox.query("CREATE FUNCTION identity_shadow.current_database() RETURNS pg_catalog.name LANGUAGE sql AS $$ SELECT 'fake_database'::pg_catalog.name $$");
    await sandbox.query("CREATE FUNCTION identity_shadow.current_setting(pg_catalog.text,pg_catalog.bool) RETURNS pg_catalog.text LANGUAGE sql AS $$ SELECT 'isolated-staging'::pg_catalog.text $$");
    await sandbox.query("CREATE FUNCTION identity_shadow.always_equal(pg_catalog.text,pg_catalog.text) RETURNS pg_catalog.bool LANGUAGE sql IMMUTABLE AS $$ SELECT true $$");
    await sandbox.query("CREATE OPERATOR identity_shadow.= (LEFTARG=pg_catalog.text, RIGHTARG=pg_catalog.text, FUNCTION=identity_shadow.always_equal)");
    await sandbox.query("SET search_path = identity_shadow, pg_catalog, public");
    const { rows: [shadow] } = await sandbox.query("SELECT current_database() AS name, 'unrelated'::pg_catalog.text = 'expected'::pg_catalog.text AS equal");
    assert.equal(shadow.name, "fake_database");
    assert.equal(shadow.equal, true);
    ({ rows: [row] } = await sandbox.query(isolatedDatabaseIdentitySql));
    assert.equal(row.database_name, name);
    assert.equal(row.database_marker, false);
    assert.equal(isIsolatedDatabaseIdentity(row, name), false);
    await sandbox.query("SELECT pg_catalog.set_config('profino.environment', 'not-isolated', false)");
    ({ rows: [row] } = await sandbox.query(isolatedDatabaseIdentitySql));
    assert.equal(row.environment, "not-isolated");
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
