import assert from "node:assert/strict";
import { Bot } from "grammy";

const stage = process.argv[2];
assert.ok(["candidate-first", "rollback-reference", "candidate-return"].includes(stage));
const db = new URL(process.env.DATABASE_URL);
assert.equal(db.hostname, "127.0.0.1");
assert.equal(db.pathname, "/drill_restored");
const root = stage === "rollback-reference" ? "../rollback-reference/" : "../";
const { startScheduler } = await import(root + "src/scheduler.js");
const { pool, closeDatabase } = await import(root + "src/database.js");
const owner = 8810232463;
const bot = new Bot("offline", { botInfo: { id: 7, is_bot: true, first_name: "Test", username: "fixture_bot" } });
let sends = 0;
let expireAck = false;
let loseSendResponse = false;
bot.api.config.use(async (_prev, method, payload) => {
  if (method === "sendMessage") {
    assert.equal(payload.chat_id, "@PROFINO1");
    assert.equal(payload.text, "Fixture post\n\nOffline publication");
    sends++;
    if (loseSendResponse) throw new Error("synthetic lost delivery response");
    return { ok: true, result: { message_id: 900 } };
  }
  assert.ok(["answerCallbackQuery", "editMessageText"].includes(method));
  if (method === "answerCallbackQuery" && expireAck) throw new Error("synthetic expired callback");
  return { ok: true, result: true };
});
let sequence = 0;
async function approve(id) {
  await bot.handleUpdate({ update_id: ++sequence, callback_query: { id: String(sequence), data: "post_approve:" + id,
    from: { id: owner, is_bot: false, first_name: "Fixture" }, chat_instance: "offline",
    message: { message_id: id, date: 0, chat: { id: owner, type: "private" } } } });
}
const scheduler = startScheduler(bot);
try {
  assert.equal(await scheduler.ready, true);
  if (stage === "candidate-first") {
    expireAck = true;
    await approve(71);
    expireAck = false;
    loseSendResponse = true;
    await approve(73);
    assert.equal(sends, 2);
  } else if (stage === "rollback-reference") {
    await approve(71);
    await approve(73);
    assert.equal(sends, 0);
    await approve(72);
    assert.equal(sends, 1);
  } else {
    for (const id of [71, 72, 73]) await approve(id);
    assert.equal(sends, 0);
  }
  for (const id of [71, 72, 73]) {
    const expected = id === 72 && stage === "candidate-first" ? ["preview_sent"] :
      ["preview_sent", "publishing", id === 73 ? "publish_unknown" : "published"];
    const history = await pool.query("SELECT new_status FROM scheduled_post_history WHERE post_id=$1 ORDER BY id", [id]);
    assert.deepEqual(history.rows.map(row => row.new_status), expected);
    const { rows: [post] } = await pool.query("SELECT status, published_message_id FROM scheduled_posts WHERE id=$1", [id]);
    assert.equal(post.status, expected.at(-1));
    assert.equal(post.published_message_id, post.status === "published" ? "900" : null);
  }
} finally {
  scheduler.stop();
  await closeDatabase();
}
