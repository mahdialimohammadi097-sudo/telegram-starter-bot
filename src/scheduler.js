
import { InlineKeyboard } from "grammy";
import { pool } from "./database.js";

const ADMIN_ID = 8810232463;
const CHANNEL_USERNAME = "@PROFINO1";
const CHECK_INTERVAL_MS = 15000;

let isRunning = false;

async function processScheduledPosts(bot) {
  if (isRunning) return;
  isRunning = true;

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const result = await client.query(`
      SELECT id, title, content, scheduled_at
      FROM scheduled_posts
      WHERE status = 'scheduled'
        AND scheduled_at <= NOW()
      ORDER BY scheduled_at ASC
      LIMIT 5
      FOR UPDATE SKIP LOCKED
    `);

    for (const post of result.rows) {
      const keyboard = new InlineKeyboard()
        .text("Approve & Publish", `post_approve:${post.id}`)
        .text("Reject", `post_reject:${post.id}`);

      const scheduledTime = new Date(post.scheduled_at).toLocaleString(
        "en-GB",
        { timeZone: "Asia/Tehran" }
      );

      const preview = [
        "PROFINO — POST PREVIEW",
        "",
        `Title: ${post.title}`,
        "",
        post.content,
        "",
        `Scheduled time: ${scheduledTime}`,
        "",
        "This post will NOT be published until you approve it."
      ].join("\n");

      const message = await bot.api.sendMessage(
        ADMIN_ID,
        preview,
        { reply_markup: keyboard }
      );

      await client.query(
        `UPDATE scheduled_posts
         SET status = 'preview_sent',
             preview_message_id = $1,
             preview_chat_id = $2,
             updated_at = NOW()
         WHERE id = $3 AND status = 'scheduled'`,
        [message.message_id, message.chat.id, post.id]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }
    console.error("PROFINO scheduler error:", error);
  } finally {
    if (client) client.release();
    isRunning = false;
  }
}

async function handlePostAction(ctx) {
  if (ctx.from?.id !== ADMIN_ID) {
    await ctx.answerCallbackQuery({
      text: "Unauthorized.",
      show_alert: true
    });
    return;
  }

  const data = ctx.callbackQuery.data;
  const match = data.match(/^post_(approve|reject):(\d+)$/);

  if (!match) return;

  const action = match[1];
  const postId = match[2];

  if (action === "reject") {
    const result = await pool.query(
      `UPDATE scheduled_posts
       SET status = 'rejected', updated_at = NOW()
       WHERE id = $1 AND status = 'preview_sent'
       RETURNING id`,
      [postId]
    );

    await ctx.answerCallbackQuery({
      text: result.rowCount ? "Post rejected." : "Post is no longer available."
    });

    if (result.rowCount) {
      await ctx.editMessageText("PROFINO — Post rejected.");
    }
    return;
  }

  const result = await pool.query(
    `UPDATE scheduled_posts
     SET status = 'approved',
         approved_by = $1,
         updated_at = NOW()
     WHERE id = $2 AND status = 'preview_sent'
     RETURNING title, content`,
    [ADMIN_ID, postId]
  );

  if (!result.rowCount) {
    await ctx.answerCallbackQuery({
      text: "Post is no longer available.",
      show_alert: true
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Publishing..." });

  const post = result.rows[0];

  try {
    const published = await ctx.api.sendMessage(
      CHANNEL_USERNAME,
      `${post.title}\n\n${post.content}`
    );

    await pool.query(
      `UPDATE scheduled_posts
       SET status = 'published',
           published_message_id = $1,
           published_at = NOW(),
           updated_at = NOW()
       WHERE id = $2 AND status = 'approved'`,
      [published.message_id, postId]
    );

    await ctx.editMessageText("PROFINO — Post successfully published.");
  } catch (error) {
    console.error("PROFINO publishing error:", error);

    await pool.query(
      `UPDATE scheduled_posts
       SET status = 'failed', updated_at = NOW()
       WHERE id = $1 AND status = 'approved'`,
      [postId]
    );

    await ctx.editMessageText(
      "PROFINO — Publishing failed. Please check the bot logs."
    );
  }
}

export function startScheduler(bot) {
  bot.on("callback_query:data", handlePostAction);

  processScheduledPosts(bot);

  setInterval(() => {
    processScheduledPosts(bot);
  }, CHECK_INTERVAL_MS);

  console.log("PROFINO scheduler started.");
}
  
