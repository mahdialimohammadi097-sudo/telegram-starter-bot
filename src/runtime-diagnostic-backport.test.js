import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

// Deliberately unreachable synthetic endpoint; pool queries are mocked before use.
process.env.DATABASE_URL = "postgresql://" + "fixture:fixture@127.0.0.1:1/runtime_fixture";
const {pool}=await import("./database.js");
const {getAdminLanguage}=await import("./admin-language.js");

test("admin language lookup falls back without leaking database details",async t=>{
 const logs=[];
 t.mock.method(console,"error",(...args)=>logs.push(args));
 const marker="synthetic private connection details";
 const query=t.mock.method(pool,"query",async()=>{
  throw Object.assign(new Error(marker),{code:"PRIVATE8",detail:marker});
 });
 assert.equal(await getAdminLanguage({from:{id:123}}),"en");
 assert.deepEqual(logs,[["[admin-language] lookup failed:","UNAVAILABLE"]]);
 assert.ok(!JSON.stringify(logs).includes(marker));
 assert.equal(query.mock.callCount(),1);
});

test("runtime entrypoint retains sanitized diagnostic call sites",async()=>{
 // Static regression: do not import the actual startup entrypoint or contact Telegram.
 const source=await readFile(new URL("../index.js",import.meta.url),"utf8");
 assert.ok(!source.includes("error?.message"));
 assert.ok(!source.includes("error.error ?? error"));
 assert.ok(!source.includes("webhook registered at"));
 assert.ok(source.includes("schemaError = safeDiagnosticCode(error)"));
 assert.ok(source.includes("safeDiagnosticCode(error?.error ?? error)"));
 assert.ok(source.includes("safeTelegramDiagnosticCode(error, safeDiagnosticCode(error))"));
});
