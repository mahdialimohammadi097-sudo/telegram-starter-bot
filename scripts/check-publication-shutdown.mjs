import assert from "node:assert/strict";
import { Bot } from "grammy";
import { startScheduler } from "../src/scheduler.js";
import { pool, closeDatabase } from "../src/database.js";

const stage = process.argv[2];
assert.ok(["drain", "restart"].includes(stage));
const db = new URL(process.env.DATABASE_URL);
assert.equal(db.hostname, "127.0.0.1");
assert.equal(db.pathname, "/drill_restored");
const owner = 8810232463;
const bot = new Bot("offline", { botInfo: { id: 7, is_bot: true, first_name: "Test", username: "fixture_bot" } });
const lock = await pool.connect();
let sends = 0;
bot.api.config.use(async (_prev, method, payload) => {
  if (method === "sendMessage") {
    assert.equal(payload.chat_id, "@PROFINO1");
    sends++;
    if (stage === "drain") {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM scheduled_posts WHERE id=91 FOR UPDATE");
    }
    return { ok: true, result: { message_id: 910 } };
  }
  assert.ok(["editMessageText", "answerCallbackQuery"].includes(method));
  return { ok: true, result: true };
});
let seq = 0;
function approve(id) {
  return bot.handleUpdate({ update_id: ++seq, callback_query: { id: String(seq), data: "post_approve:" + id,
    from: { id: owner, is_bot: false, first_name: "Fixture" }, chat_instance: "offline",
    message: { message_id: id, date: 0, chat: { id: owner, type: "private" } } } });
}
let scheduler;
let pending;
try {
  if (stage === "drain") {
    await pool.query(`INSERT INTO scheduled_posts(id,title,content,status,preview_chat_id,preview_message_id)
      SELECT i,'Shutdown','Offline','preview_sent',$1,i FROM generate_series(91,92) i`, [owner]);
  } else {
    await pool.query("INSERT INTO scheduled_posts(id,title,status,preview_chat_id,preview_message_id) VALUES (93,'Interrupted','publishing',$1,93)", [owner]);
  }
  scheduler = startScheduler(bot);
  assert.equal(await scheduler.ready, true);
  if (stage === "drain") {
    pending = approve(91);
    const deadline = Date.now() + 8000;
    for (;;) {
      const { rows: [row] } = await pool.query(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
        [lock.processID]);
      if (row.waiting) break;
      assert.ok(Date.now() < deadline, "publication reached its final database write");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    let finished = false;
    const stopping = scheduler.stop().then(() => { finished = true; });
    await approve(92);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    await lock.query("ROLLBACK");
    await Promise.all([stopping, pending]);
  } else {
    await approve(91);
    await approve(93);
  }
  assert.equal(sends, stage === "drain" ? 1 : 0);
  const { rows } = await pool.query("SELECT id,status,published_message_id FROM scheduled_posts WHERE id BETWEEN 91 AND 93 ORDER BY id");
  const expected = [{ id: "91", status: "published", published_message_id: "910" },
    { id: "92", status: "preview_sent", published_message_id: null }];
  if (stage === "restart") expected.push({ id: "93", status: "publish_unknown", published_message_id: null });
  assert.deepEqual(rows, expected);
  const history = await pool.query("SELECT new_status FROM scheduled_post_history WHERE post_id=91 ORDER BY id");
  assert.deepEqual(history.rows.map(row => row.new_status), ["preview_sent", "publishing", "published"]);
} finally {
  await lock.query("ROLLBACK");
  lock.release();
  await pending;
  await scheduler?.stop();
  await closeDatabase();
}
