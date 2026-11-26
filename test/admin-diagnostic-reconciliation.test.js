import test from "node:test";
import assert from "node:assert/strict";

// No live credentials or connection. All database calls are intercepted.
process.env.DATABASE_URL = "postgresql://127.0.0.1:1/diagnostic_fixture";
process.env.PROFINO_RUNTIME_SCHEMA_MODE = "legacy-prepare";
process.env.PROFINO_DB_TLS_MODE = "disable";
delete process.env.PROFINO_DATABASE_TLS;
const { pool } = await import("../src/database.js");
const { registerAdminOps } = await import("../src/admin-ops.js");
const { getAdminLanguage } = await import("../src/admin-language.js");
const ownerId = 8810232463;

test("owner dbschema connection failure returns only sanitized diagnostics in both languages", async t => {
  const commands = new Map();
  registerAdminOps({command(name, fn) { commands.set(name, fn); }, callbackQuery() {}});
  const handler = commands.get("dbschema");
  assert.equal(typeof handler, "function");
  let language = "en";
  const logs = [];
  const secret = "synthetic private diagnostic details";
  t.mock.method(console, "error", (...args) => logs.push(args));
  const query = t.mock.method(pool, "query", async sql => {
    assert.match(sql, /admin_preferences/);
    return {rows:[{language}]};
  });
  const connect = t.mock.method(pool, "connect", async () => {
    throw Object.assign(new Error(secret), {code:"28P01", detail:secret, stack:secret});
  });
  for (const locale of ["en", "fa"]) {
    language = locale;
    const replies = [];
    await handler({from:{id:ownerId},chat:{id:ownerId,type:"private"},reply:async value=>replies.push(value)});
    assert.equal(replies.length, 1);
    assert.match(replies[0], locale === "en" ? /Diagnostic: 28P01$/ : /جزئیات: 28P01$/);
    assert.deepEqual(logs.at(-1), ["[admin-ops] core database schema inspection failed:", "28P01"]);
    assert.ok(!JSON.stringify([replies,logs]).includes(secret));
  }
  assert.equal(query.mock.callCount(), 2);
  assert.equal(connect.mock.callCount(), 2);
});

test("admin language fallback suppresses malformed diagnostic codes and raw errors", async t => {
  const logs = [];
  const secret = "synthetic private preference details";
  t.mock.method(console, "error", (...args)=>logs.push(args));
  const query = t.mock.method(pool,"query",async()=>{
    throw Object.assign(new Error(secret), {code:"PRIVATE8",detail:secret});
  });
  assert.equal(await getAdminLanguage({from:{id:123}}), "en");
  assert.deepEqual(logs,[["[admin-language] lookup failed:","UNAVAILABLE"]]);
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.equal(query.mock.callCount(),1);
});

test.after(async()=>{ await pool.end(); });
