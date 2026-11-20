import test from "node:test";
import assert from "node:assert/strict";
import { resolveDatabaseTls } from "./database-tls-policy.js";

test("legacy private-network mode is explicit and disabled by default", () => {
  assert.equal(resolveDatabaseTls({}), false);
  assert.equal(resolveDatabaseTls({ PROFINO_DB_TLS_MODE: "disable" }), false);
});
test("verify-full enables certificate validation", () => {
  assert.deepEqual(resolveDatabaseTls({ PROFINO_DB_TLS_MODE: "verify-full" }), { rejectUnauthorized: true });
});
test("verify-full uses provided CA without disabling verification", () => {
  const ca = "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----";
  assert.deepEqual(resolveDatabaseTls({ PROFINO_DB_TLS_MODE: "verify-full", PROFINO_DB_TLS_CA_PEM: ca }), { rejectUnauthorized: true, ca });
});
test("invalid modes and empty CA fail closed", () => {
  assert.throws(() => resolveDatabaseTls({ PROFINO_DB_TLS_MODE: "require" }));
  assert.throws(() => resolveDatabaseTls({ PROFINO_DB_TLS_MODE: "verify-full", PROFINO_DB_TLS_CA_PEM: " " }));
});

test("verify-full rejects connection URL SSL overrides", () => {
  for (const parameter of ["sslmode=disable", "sslmode=no-verify", "sslrootcert=path", "sslcert=path", "sslkey=path"]) {
    assert.throws(() => resolveDatabaseTls({
      PROFINO_DB_TLS_MODE: "verify-full",
      DATABASE_URL: "postgresql://localhost/profino?" + parameter
    }), /conflict/);
  }
});
test("verify-full accepts a connection URL without TLS overrides", () => {
  assert.deepEqual(resolveDatabaseTls({
    PROFINO_DB_TLS_MODE: "verify-full",
    DATABASE_URL: "postgresql://localhost/profino?application_name=profino"
  }), { rejectUnauthorized: true });
});
