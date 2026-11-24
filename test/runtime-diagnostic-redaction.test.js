import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = name => readFileSync(new URL("../src/" + name, import.meta.url), "utf8");

test("admin language lookup falls back without disclosing database error details", async () => {
  const logs = [];
  const code = source("admin-language.js").replace(/^import .*;$/m, "").replaceAll("export ", "");
  const lookup = vm.runInNewContext(code + "\ngetAdminLanguage", {
    pool: { async query() { throw new Error("synthetic-sensitive-detail"); } },
    console: { error(...args) { logs.push(args); } }
  });
  assert.equal(await lookup({ from: { id: 123 } }), "en");
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1], "operation_failed");
  assert.doesNotMatch(JSON.stringify(logs), /synthetic-sensitive-detail/);
});

for (const name of ["admin-language.js", "admin-ops.js", "commands.js", "scheduler.js", "post-management.js", "post-history.js"]) {
  test(name + " error log calls retain fixed diagnostic labels", () => {
    const code = source(name);
    const calls = [...code.matchAll(/console\.error\([\s\S]*?\);/g)];
    assert.ok(calls.length > 0);
    for (const [call] of calls) {
      assert.match(call, /,\s*"operation_failed"\s*\);$/);
    }
  });
}

test("health monitor uses fixed failure labels", () => {
  const code = source("health-monitor.js");
  const calls = [...code.matchAll(/logger\.error\([\s\S]*?\);/g)];
  assert.equal(calls.length, 2);
  for (const [call] of calls) assert.match(call, /,\s*"(telegram_send_failed|check_failed)"\s*\);$/);
});
