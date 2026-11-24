import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/admin-ops.js", import.meta.url), "utf8");
const body = source.slice(source.indexOf("async function applyUserStatus("), source.indexOf("export async function ensureAdminOpsSchema("));
function setup({ failQuery = false, failRollback = false, failReply = false } = {}) {
  const calls = [], releases = [];
  const original = new Error("synthetic failure");
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT") return {};
      if (sql === "ROLLBACK") {
        if (failRollback) throw new Error("synthetic rollback failure");
        return {};
      }
      if (failQuery) throw original;
      if (sql.includes("FOR UPDATE")) return { rowCount: 1, rows: [{ id: 2, status: "active" }] };
      if (sql.includes("FROM admin_users")) return { rowCount: 1, rows: [{ user_id: 1 }] };
      if (sql.includes("UPDATE users")) return { rowCount: 1, rows: [{ id: 2 }] };
      return { rowCount: 1 };
    },
    release(error) { releases.push(error); }
  };
  const apply = vm.runInNewContext(body + "\napplyUserStatus", {
    pool: { connect: async () => client }, SUPER_ADMIN_ID: 123,
    getAdminLanguage: async () => "en", isConfirmationCurrent: () => true,
    showUser: async () => {}
  });
  const ctx = { answerCallbackQuery: async () => { if (failReply) throw original; } };
  return { run: () => apply(ctx, "456", "blocked", "active"), calls, releases, original };
}

test("admin transaction discards client if rollback fails", async () => {
  const s = setup({ failQuery: true, failRollback: true });
  await assert.rejects(s.run(), error => error === s.original);
  assert.equal(s.calls.at(-1), "ROLLBACK");
  assert.equal(s.releases.length, 1);
  assert.equal(s.releases[0]?.message, "admin_status_rollback_failed");
});

test("admin transaction does not roll back a committed change after Telegram reply fails", async () => {
  const s = setup({ failReply: true });
  await assert.rejects(s.run(), error => error === s.original);
  assert.equal(s.calls.at(-1), "COMMIT");
  assert.ok(!s.calls.includes("ROLLBACK"));
  assert.equal(s.releases.length, 1);
  assert.equal(s.releases[0], undefined);
});
