
import { InlineKeyboard } from "grammy";
import { pool } from "./database.js";

const ADMIN_ID = 8810232463;
const CHANNEL_USERNAME = "@PROFINO1";
const CHECK_INTERVAL_MS = 15000;
const BATCH_SIZE = 5;

let isRunning = false;
let isStarted = false;

async function recoverInterruptedOperations() {
  const previewResult = await pool.query(`
    UPDATE scheduled_posts
    SET status = 'preview_unknown',
        updated_at = NOW()
    WHERE status = 'preview_sending'
  `);

  const publishResult = await pool.query(`
    UPDATE scheduled_posts
    SET status = 'publish_unknown',
        updated_at = NOW()
    WHERE status = 'publishing'
  `);

  console.log(
    `[scheduler] recovered ${previewResult.rowCount} interrupted previews.`
  );

  console.log(
    `[scheduler] recovered ${publishResult.rowCount} interrupted publications.`
  );
}

async function claimScheduledPosts() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const selected = await client.query(`
      SELECT id, title, content, scheduled_at
      FROM scheduled_posts
      WHERE status = 'scheduled'
        AND scheduled_at <= NOW()
      ORDER BY scheduled_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `, [BATCH_SIZE]);

    const ids = selected.rows.map((post) => post.id);

    if (ids.length === 0) {
      await client.query("COMMIT");
      return [];
    }

    const claimed = await client.query(`
      UPDATE scheduled_posts
      SET status = 'preview_sending',
          updated_at = NOW()
      WHERE id = ANY($1::bigint[])
        AND status = 'scheduled'
      RETURNING id, title, content, scheduled_at
    `, [ids]);

    await client.query("COMMIT");

    return claimed.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function sendPreview(bot, post) {
  try {
    const scheduledTime = new Date(post.scheduled_at).toLocaleString(
      "en-GB",
      {
        timeZone: "UTC",
        dateStyle: "medium",
        timeStyle: "short"
      }
    );

    const preview = [
      "PROFINO — POST PREVIEW",
      "",
      `Post ID: ${post.id}`,
      `Title: ${post.title}`,
      "",
      post.content,
      "",
      `Scheduled time: ${scheduledTime} UTC`,
      "",
      "This post will NOT be published until you approve it."
    ].join("\n");

    const keyboard = new InlineKeyboard()
      .text("Approve & Publish", `post_approve:${post.id}`)
      .text("Reject", `post_reject:${post.id}`)
      .row()
      .text("Edit Post", `post_edit:${post.id}`)
      .text("Reschedule", `post_time:${post.id}`)
      .row()
      .text("Cancel Post", `post_cancel:${post.id}`);

    const message = await bot.api.sendMessage(
      ADMIN_ID,
      preview,
      { reply_markup: keyboard }
    );

    await pool.query(`
      UPDATE scheduled_posts
      SET status = 'preview_sent',
          preview_message_id = $1,
          preview_chat_id = $2,
          updated_at = NOW()
      WHERE id = $3
        AND status = 'preview_sending'
    `, [
      message.message_id,
      message.chat.id,
      post.id
    ]);

    console.log(`[scheduler] preview sent for post ${post.id}.`);
  } catch (error) {
    console.error(
      `[scheduler] preview result uncertain for post ${post.id}:`,
      error
    );

    try {
      await pool.query(`
        UPDATE scheduled_posts
        SET status = 'preview_unknown',
            updated_at = NOW()
        WHERE id = $1
          AND status = 'preview_sending'
      `, [post.id]);
    } catch (databaseError) {
      console.error(
        `[scheduler] could not record preview uncertainty for post ${post.id}:`,
        databaseError
      );
    }
  }
}

async function processScheduledPosts(bot) {
  if (isRunning) return;

  isRunning = true;

  try {
    const posts = await claimScheduledPosts();

    for (const post of posts) {
      await sendPreview(bot, post);
    }
  } catch (error) {
    console.error("[scheduler] processing error:", error);
  } finally {
    isRunning = false;
  }
}

async function updateAdminMessage(ctx, text) {
  try {
    await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } });
  } catch (error) {
    console.error("[scheduler] could not update admin message:", error);
  }
}

async function handlePostAction(ctx) {
  if (
    ctx.from?.id !== ADMIN_ID ||
    ctx.callbackQuery.message?.chat?.id !== ADMIN_ID
  ) {
    await ctx.answerCallbackQuery({
      text: "Unauthorized.",
      show_alert: true
    });
    return;
  }

  const match = ctx.callbackQuery.data.match(
    /^post_(approve|reject):(\d+)$/
  );

  if (!match) {
    await ctx.answerCallbackQuery({
      text: "Invalid action."
    });
    return;
  }

  const action = match[1];
  const postId = match[2];

  if (action === "reject") {
    try {
      const result = await pool.query(`
        UPDATE scheduled_posts
        SET status = 'rejected',
            updated_at = NOW()
        WHERE id = $1
          AND status = 'preview_sent'
          AND preview_message_id = $2
          AND preview_chat_id = $3
        RETURNING id
      `, [postId, ctx.callbackQuery.message.message_id, ctx.callbackQuery.message.chat.id]);

      if (!result.rowCount) {
        await ctx.answerCallbackQuery({
          text: "Post is no longer available.",
          show_alert: true
        });
        return;
      }

      await ctx.answerCallbackQuery({
        text: "Post rejected."
      });

      await updateAdminMessage(
        ctx,
        `PROFINO — Post ${postId} rejected.`
      );
    } catch (error) {
      console.error("[scheduler] rejection error:", error);

      await ctx.answerCallbackQuery({
        text: "Database error. Please try again.",
        show_alert: true
      });
    }

    return;
  }

  let post;

  try {
    const result = await pool.query(`
      UPDATE scheduled_posts
      SET status = 'publishing',
          approved_by = $1,
          updated_at = NOW()
      WHERE id = $2
        AND status = 'preview_sent'
        AND preview_message_id = $3
        AND preview_chat_id = $4
      RETURNING id, title, content
    `, [ADMIN_ID, postId, ctx.callbackQuery.message.message_id, ctx.callbackQuery.message.chat.id]);

    if (!result.rowCount) {
      await ctx.answerCallbackQuery({
        text: "Post is no longer available.",
        show_alert: true
      });
      return;
    }

    post = result.rows[0];
  } catch (error) {
    console.error("[scheduler] approval database error:", error);

    await ctx.answerCallbackQuery({
      text: "Database error. Nothing was published.",
      show_alert: true
    });

    return;
  }

  await ctx.answerCallbackQuery({
    text: "Approval received. Publishing..."
  });

  let published;

  try {
    published = await ctx.api.sendMessage(
      CHANNEL_USERNAME,
      `${post.title}\n\n${post.content}`
    );
  } catch (error) {
    console.error(
      `[scheduler] publication result uncertain for post ${postId}:`,
      error
    );

    try {
      await pool.query(`
        UPDATE scheduled_posts
        SET status = 'publish_unknown',
            updated_at = NOW()
        WHERE id = $1
          AND status = 'publishing'
      `, [postId]);
    } catch (databaseError) {
      console.error(
        "[scheduler] could not record publication uncertainty:",
        databaseError
      );
    }

    await updateAdminMessage(
      ctx,
      `PROFINO — Post ${postId}\n\n` +
      "Publication result is uncertain.\n" +
      "Check the channel before taking any further action.\n" +
      "Automatic retry is disabled."
    );

    return;
  }

  try {
    await pool.query(`
      UPDATE scheduled_posts
      SET status = 'published',
          published_message_id = $1,
          published_at = NOW(),
          updated_at = NOW()
      WHERE id = $2
        AND status = 'publishing'
    `, [published.message_id, postId]);

    console.log(`[scheduler] post ${postId} published successfully.`);

    await updateAdminMessage(
      ctx,
      `PROFINO — Post ${postId} successfully published.\n\n` +
      `Channel: ${CHANNEL_USERNAME}\n` +
      `Message ID: ${published.message_id}`
    );
  } catch (error) {
    console.error(
      `[scheduler] post ${postId} was sent, but database confirmation failed:`,
      error
    );

    await updateAdminMessage(
      ctx,
      `PROFINO — Post ${postId} was sent to the channel.\n\n` +
      "Database confirmation failed.\n" +
      "Please verify the channel and database status manually."
    );
  }
}

export function startScheduler(bot) {
  if (isStarted) return;

  isStarted = true;

  bot.callbackQuery(
    /^post_(approve|reject):\d+$/,
    handlePostAction
  );

  recoverInterruptedOperations()
    .then(() => {
      console.log("[scheduler] recovery completed.");

      processScheduledPosts(bot);

      setInterval(() => {
        processScheduledPosts(bot);
      }, CHECK_INTERVAL_MS);

      console.log("[scheduler] scheduled-post system started.");
    })
    .catch((error) => {
      console.error(
        "[scheduler] startup recovery failed. Scheduler remains disabled:",
        error
      );
    });
        }
