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
