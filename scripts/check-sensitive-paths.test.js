import test from "node:test";
import assert from "node:assert/strict";
import { isSensitivePath, countSensitivePaths } from "./check-sensitive-paths.js";

test("blocks common credential, private key and backup filenames", () => {
  const paths = [".env", "nested/.env.production", ".ENV.local", "keys/server.PEM",
    "data/private.key", "client.p12", "client.pfx", ".pgpass", "db.pgpass",
    ".npmrc.local", "db.dump", "db.backup", "db.sql.gz", "keys/id_ed25519"];
  for (const path of paths) assert.equal(isSensitivePath(path), true, path);
  assert.equal(countSensitivePaths(paths), paths.length);
});

test("allows schema migrations, sample environment files and public keys", () => {
  const paths = [".env.example", ".env.sample", "db/schema.sql", "README.md",
    "test/fixture.js", "keys/id_ed25519.pub", "package-lock.json"];
  assert.equal(countSensitivePaths(paths), 0);
});
