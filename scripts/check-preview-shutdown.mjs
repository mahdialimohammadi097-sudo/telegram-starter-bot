import assert from "node:assert/strict";
import { Bot } from "grammy";
import { startScheduler } from "../src/scheduler.js";
import { pool, closeDatabase } from "../src/database.js";

const stage = process.argv[2];
assert.ok(["drain", "restart"].includes(stage));
const db = new URL(process.env.DATABASE_URL);
assert.equal(db.hostname, "127.0.0.1");
assert.equal(db.pathname, "/drill_restored");

const bot = new Bot("offline", { botInfo: { id: 7, is_bot: true, first_name: "Test", username: "fixture_bot" } });
const entered = Promise.withResolvers();
const delivery = Promise.withResolvers();
let attempts = 0;
bot.api.config.use(async (_prev, method, payload) => {
  attempts++;
  assert.equal(method, "sendMessage");
  assert.equal(payload.chat_id, 8810232463);
  const keys = payload.reply_markup.inline_keyboard.flat().map(button => button.callback_data);
  assert.ok(keys.includes("post_approve:81"));
  entered.resolve();
  await delivery.promise;
  return { ok: true, result: { message_id: 810, chat: { id: 8810232463 } } };
});

let scheduler;
try {
  if (stage === "drain") {
    await pool.query(`INSERT INTO scheduled_posts(id,title,content,status,scheduled_at)
      VALUES (81,'Shutdown fixture','Offline preview','scheduled',now())`);
  } else {
    // Emulate a previous process that lost its delivery result before recording it.
    await pool.query(`INSERT INTO scheduled_posts(id,title,content,status,scheduled_at)
      VALUES (82,'Interrupted fixture','Uncertain preview','preview_sending',now())`);
  }
  scheduler = startScheduler(bot);
  assert.equal(await scheduler.ready, true);
  if (stage === "drain") {
    let timer;
    try {
      await Promise.race([entered.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture preview did not start")), 5000);
      })]);
    } finally {
      clearTimeout(timer);
    }
    let stopped = false;
    const drain = scheduler.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    delivery.resolve();
    await drain;
  } else {
    await scheduler.stop();
  }
  assert.equal(attempts, stage === "drain" ? 1 : 0);
  const history = async id => (await pool.query(
    "SELECT new_status FROM scheduled_post_history WHERE post_id=$1 ORDER BY id", [id]
  )).rows.map(row => row.new_status);
  assert.deepEqual(await history(81), ["scheduled", "preview_sending", "preview_sent"]);
  const { rows: [post] } = await pool.query("SELECT preview_message_id, preview_chat_id FROM scheduled_posts WHERE id=81");
  assert.deepEqual(post, { preview_message_id: "810", preview_chat_id: "8810232463" });
  if (stage === "restart") assert.deepEqual(await history(82), ["preview_sending", "preview_unknown"]);
} finally {
  delivery.resolve();
  await scheduler?.stop();
  await closeDatabase();
}
