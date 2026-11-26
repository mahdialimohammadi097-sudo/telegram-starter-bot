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

test("blocks encrypted and compressed PostgreSQL exports and service configuration",()=>{
  const paths=[".pg_service.conf","config/pg_service.conf","private/DB.DUMP.AGE",
    "exports/db.backup.gpg","exports/db.pgdump","exports/db.dump.gz.enc",
    "exports/db.sql.xz","exports/db.sql.zst.age","exports/db.sql.gpg","exports/db.backup.zip"];
  assert.equal(countSensitivePaths(paths),paths.length);
  assert.equal(countSensitivePaths(["migrations/schema.sql","docs/backup.md","sample.pg_service.conf.example","public/logo.svg"]),0);
});

test("blocks temporary, rotated and wrapped protected database archives", () => {
  const paths = ["db.dump.tmp", "db.backup.1", "db.pgdump.partial",
    "nested/db.sql.gz.tmp", "db.sql.age.partial", "db.sql.gpg.bak",
    "db.sql.enc.20261126", "DB.SQL.AES.TMP", "db.dump.tar"];
  for (const path of paths) assert.equal(isSensitivePath(path), true, path);
  assert.equal(countSensitivePaths(paths), paths.length);
  assert.equal(countSensitivePaths(["migrations/001.sql", "docs/backup.md",
    "src/backup.js", "sample.sql.example"]), 0);
});
