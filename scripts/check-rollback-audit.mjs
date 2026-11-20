import assert from "node:assert/strict";
import { Bot } from "grammy";

const revision = process.argv[2];
assert.ok(["rollback-reference", "candidate"].includes(revision));
const db = new URL(process.env.DATABASE_URL);
assert.equal(db.hostname, "127.0.0.1");
assert.equal(db.pathname, "/drill_restored");
const previous = revision === "rollback-reference";
const root = previous ? "../rollback-reference/" : "../";
const { ensureAdminOpsSchema, registerAdminOps } = await import(root + "src/admin-ops.js");
const { ensurePostHistorySchema } = await import(root + "src/post-history.js");
const { pool, closeDatabase } = await import(root + "src/database.js");
try {
  await ensurePostHistorySchema();
  await ensureAdminOpsSchema();
  const bot = new Bot("offline", { botInfo: { id: 7, is_bot: true, first_name: "Test", username: "fixture_bot" } });
  registerAdminOps(bot);
  const replies = [];
  bot.api.config.use(async (_prev, method, payload) => {
    assert.equal(method, "sendMessage");
    replies.push(payload.text);
    return { ok: true, result: true };
  });
  const owner = 8810232463;
  const records = () => pool.query(`SELECT id, actor_telegram_id, currency, details, metadata FROM admin_audit_logs
    WHERE action='admin_activity_viewed' ORDER BY id`);
  const before = await records();
  assert.equal(before.rowCount, previous ? 0 : 1);
  await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, text: "/adminlogs",
    entities: [{ type: "bot_command", offset: 0, length: 10 }],
    from: { id: owner, first_name: "Fixture", is_bot: false }, chat: { type: "private", id: owner } } });
  assert.equal(replies.length, 1);
  assert.match(replies[0], /گزارش فعالیت مدیر/);
  assert.match(replies[0], /RESTORE_DRILL/);
  assert.match(replies[0], /LEGACY_FIXTURE/);
  const labels = previous ? /ADMIN_ACTIVITY_VIEWED/g : /گزارش فعالیت مشاهده شد/g;
  assert.equal((replies[0].match(labels) ?? []).length, before.rowCount + 1);
  const after = await records();
  assert.deepEqual(after.rows.slice(0, -1), before.rows);
  assert.equal(after.rowCount, before.rowCount + 1);
  assert.equal(after.rows.at(-1).actor_telegram_id, String(owner));
  assert.equal(after.rows.at(-1).currency, "USDT");
  assert.deepEqual(after.rows.at(-1).details, {});
  assert.deepEqual(after.rows.at(-1).metadata, {});
} finally {
  await closeDatabase();
}
