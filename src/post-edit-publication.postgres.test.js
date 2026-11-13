import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Bot } from "grammy";
import pg from "pg";

test("only the replacement preview can publish the saved post after an edit", {
  skip: !process.env.DATABASE_URL
}, async t => {
  const { pool } = await import("./database.js");
  const { registerPostManagement } = await import("./post-management.js");
  const { startScheduler } = await import("./scheduler.js");
  const schema = "post_edit_" + randomUUID().replaceAll("-", "");
  const setup = await pool.connect();
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, application_name: schema, options: "-c search_path=" + schema });
  const owner = 8810232463;
  const chat = { id: owner, type: "private" };
  const from = { id: owner, first_name: "Fixture", is_bot: false };
  const bot = new Bot("offline", { botInfo: { id: 7, is_bot: true, first_name: "Test", username: "fixture_bot" } });
  registerPostManagement(bot);
  const published = [];
  const previews = [];
  const notices = [];
  let sequence = 0;
  let messageId = 100;
  let staleButtonVisible = false;
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "answerCallbackQuery" || (method === "sendMessage" && payload.chat_id === owner)) {
      notices.push(payload.text ?? "");
    }
    if (method === "sendMessage") {
      const message = { message_id: ++messageId, chat: { id: payload.chat_id } };
      if (payload.chat_id === "@PROFINO1") published.push(payload.text);
      else {
        assert.equal(payload.chat_id, owner);
        if (payload.reply_markup?.inline_keyboard) previews.push({ ...message, ...payload });
      }
      return { ok: true, result: message };
    }
    if (method === "editMessageText" && String(payload.message_id) === "70") {
      staleButtonVisible = true;
      throw new Error("Simulated failure to invalidate the old Telegram preview");
    }
    assert.ok(["editMessageReplyMarkup", "editMessageText", "answerCallbackQuery"].includes(method));
    return { ok: true, result: true };
  });
  async function click(data, id) {
    await bot.handleUpdate({ update_id: ++sequence, callback_query: {
      id: String(sequence), data, from, chat_instance: "offline", message: { chat, date: 0, message_id: id }
    } });
  }
  let scheduler;
  try {
    await setup.query("CREATE SCHEMA " + schema);
    await db.query(`
      CREATE TABLE users (id bigint, telegram_id bigint);
      CREATE TABLE admin_preferences (user_id bigint, language text);
      CREATE TABLE scheduled_posts (id bigint PRIMARY KEY, title text, content text, status text,
        preview_message_id bigint, preview_chat_id bigint, approved_by bigint, edit_version int,
        scheduled_at timestamptz, last_edited_at timestamptz, updated_at timestamptz,
        published_at timestamptz, published_message_id bigint);
    `);
    await db.query(`INSERT INTO scheduled_posts
      (id,title,content,status,preview_message_id,preview_chat_id,edit_version,scheduled_at)
      VALUES (1,'Update','Old text','preview_sent',70,$1,1,now())`, [owner]);
    t.mock.method(pool, "connect", db.connect.bind(db));
    t.mock.method(pool, "query", db.query.bind(db));
    await click("post_edit_content:1", 70);
    await bot.handleUpdate({ update_id: ++sequence, message: { chat, from, message_id: 71, date: 0, text: "Revised text" } });
    const state = async () => (await db.query("SELECT * FROM scheduled_posts WHERE id=1")).rows[0];
    const saved = await state();
    assert.equal(saved.content, "Revised text");
    assert.equal(saved.status, "scheduled");
    assert.equal(saved.preview_message_id, null);
    assert.ok(staleButtonVisible);

    // Advance this fixture's due time so the real scheduler emits the replacement immediately.
    await db.query("UPDATE scheduled_posts SET scheduled_at=now() WHERE id=1");
    scheduler = startScheduler(bot);
    assert.equal(await scheduler.ready, true);
    const deadline = Date.now() + 5000;
    while ((await state()).status !== "preview_sent") {
      assert.ok(Date.now() < deadline, "scheduler did not record the replacement preview");
      await delay(20);
    }
    assert.equal(previews.length, 1);
    const [preview] = previews;
    assert.match(preview.text, /Revised text/);
    assert.equal((await state()).preview_message_id, String(preview.message_id));
    const approve = preview.reply_markup.inline_keyboard.flat().find(button => button.callback_data === "post_approve:1");
    await click(approve.callback_data, 70);
    assert.deepEqual(published, []);
    assert.equal((await state()).status, "preview_sent");
    await click(approve.callback_data, preview.message_id);
    await click(approve.callback_data, preview.message_id);
    assert.deepEqual(published, ["Update\n\nRevised text"]);
    const final = await state();
    assert.equal(final.status, "published");
    assert.equal(final.published_message_id, String(messageId));

    // Hold the row until both real handlers are waiting inside their UPDATEs.
    async function waitForBlockedWrite(sqlPrefix) {
      const limit = Date.now() + 8000;
      while (Date.now() < limit) {
        const result = await db.query(`SELECT 1 FROM pg_stat_activity
          WHERE application_name = $1 AND query LIKE $2
            AND cardinality(pg_blocking_pids(pid)) > 0`, [schema, sqlPrefix]);
        if (result.rowCount) return;
        await delay(20);
      }
      assert.fail("Timed out waiting for " + sqlPrefix);
    }

    for (const editFirst of [true, false]) {
      const id = editFirst ? 2 : 3;
      const previewId = 80 + id;
      await db.query(`INSERT INTO scheduled_posts
        (id,title,content,status,preview_message_id,preview_chat_id,edit_version,scheduled_at)
        VALUES ($1,'Race','Original','preview_sent',$2,$3,1,now())`, [id, previewId, owner]);
      await click("post_edit_content:" + id, previewId);
      const publish = () => click("post_approve:" + id, previewId);
      const edit = () => bot.handleUpdate({ update_id: ++sequence, message: {
        chat, from, message_id: 90 + id, date: 0, text: "Changed"
      } });
      const editSql = "UPDATE scheduled_posts SET content =%";
      const approveSql = "%UPDATE scheduled_posts%SET status = 'publishing'%";
      const locker = await db.connect();
      const pending = [];
      const sentBefore = published.length;
      notices.length = 0;
      try {
        await locker.query("BEGIN");
        await locker.query("SELECT id FROM scheduled_posts WHERE id=$1 FOR UPDATE", [id]);
        pending.push((editFirst ? edit : publish)());
        await waitForBlockedWrite(editFirst ? editSql : approveSql);
        pending.push((editFirst ? publish : edit)());
        await waitForBlockedWrite(editFirst ? approveSql : editSql);
      } finally {
        try { await locker.query("ROLLBACK"); }
        finally { locker.release(); }
        await Promise.all(pending);
      }
      const { rows: [post] } = await db.query("SELECT * FROM scheduled_posts WHERE id=$1", [id]);
      if (editFirst) {
        assert.equal(post.status, "scheduled");
        assert.equal(post.content, "Changed");
        assert.equal(post.preview_message_id, null);
        assert.equal(post.published_message_id, null);
        assert.deepEqual(published.slice(sentBefore), []);
        assert.ok(notices.includes("Post is no longer available."));
      } else {
        assert.equal(post.status, "published");
        assert.equal(post.content, "Original");
        assert.ok(post.published_message_id);
        assert.deepEqual(published.slice(sentBefore), ["Race\n\nOriginal"]);
        assert.ok(notices.some(text => text.includes("No changes were saved.")));
      }
    }
  } finally {
    await scheduler?.stop();
    await db.end();
    try { await setup.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE"); }
    finally { setup.release(); }
  }
});
