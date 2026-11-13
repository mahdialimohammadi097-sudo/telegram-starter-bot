import { safeDiagnosticCode } from "./diagnostic-safety.js";

import { InlineKeyboard } from "grammy";
import { pool } from "./database.js";
import { getAdminLanguage, adminText } from "./admin-language.js";

const ADMIN_ID = 8810232463;
const CHANNEL_USERNAME = "@PROFINO1";
const CHECK_INTERVAL_MS = 15000;
const BATCH_SIZE = 5;

let activeBatch = null;
let isStarted = false;
let schedulerStopped = false;
let schedulerTimer = null;

// A session lock spans the committed claim, Telegram send and final status write.
// Recovery waits for sends on other instances. Disconnecting releases the lock.
async function withSchedulerLock(shared, operation) {
  const client = await pool.connect();
  const suffix = shared ? "_shared" : "";
  let clean = false;
  let disconnected = false;
  const onDisconnect = error => {
    disconnected = true;
    console.error("[scheduler] PostgreSQL session lost:", safeDiagnosticCode(error));
  };
  client.on("error", onDisconnect);
  try {
    await client.query("SELECT pg_advisory_lock" + suffix + "(780244, 1)");
    return await operation(client);
  } finally {
    try {
      if (!disconnected) {
        const result = await client.query("SELECT pg_advisory_unlock" + suffix + "(780244, 1) AS unlocked");
        clean = result.rows[0].unlocked;
      }
    } catch (error) {
      console.error("[scheduler] PostgreSQL lock cleanup failed:", safeDiagnosticCode(error));
    } finally {
      client.off("error", onDisconnect);
      client.release(disconnected || !clean);
    }
  }
}

async function recoverInterruptedOperations() {
  return withSchedulerLock(false, client => client.query(`
    UPDATE scheduled_posts
    SET status = CASE WHEN status = 'preview_sending' THEN 'preview_unknown' ELSE 'publish_unknown' END,
        updated_at = NOW()
    WHERE status IN ('preview_sending', 'publishing')
  `));
}

async function claimScheduledPosts(client) {

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
  }
}

async function sendPreview(bot, post, client, language) {
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
      adminText(language, "PROFINO — POST PREVIEW", "پروفینو — پیش‌نمایش پست"),
      "",
      adminText(language, "Post ID: ", "شناسه پست: ") + post.id,
      adminText(language, "Title: ", "عنوان: ") + post.title,
      "",
      post.content,
      "",
      adminText(language, "Scheduled time: " + scheduledTime + " UTC", "زمان‌بندی: " + scheduledTime + " (UTC)"),
      "",
      adminText(language, "This post will NOT be published until you approve it.", "این پست تا زمان تأیید شما منتشر نخواهد شد.")
    ].join("\n");

    const keyboard = new InlineKeyboard()
      .text(adminText(language, "Approve & Publish", "تأیید و انتشار"), `post_approve:${post.id}`)
      .text(adminText(language, "Reject", "رد کردن"), `post_reject:${post.id}`)
      .row()
      .text(adminText(language, "Edit Post", "ویرایش پست"), `post_edit:${post.id}`)
      .text(adminText(language, "Reschedule", "تغییر زمان"), `post_time:${post.id}`)
      .row()
      .text(adminText(language, "Cancel Post", "لغو پست"), `post_cancel:${post.id}`);

    const message = await bot.api.sendMessage(
      ADMIN_ID,
      preview,
      { reply_markup: keyboard }
    );

    await client.query(`
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
      safeDiagnosticCode(error)
    );

    try {
      await client.query(`
        UPDATE scheduled_posts
        SET status = 'preview_unknown',
            updated_at = NOW()
        WHERE id = $1
          AND status = 'preview_sending'
      `, [post.id]);
    } catch (databaseError) {
      console.error(
        `[scheduler] could not record preview uncertainty for post ${post.id}:`,
        safeDiagnosticCode(databaseError)
      );
    }
  }
}

async function processScheduledPosts(bot) {
  try {
    await withSchedulerLock(true, async client => {
      const posts = await claimScheduledPosts(client);
      if (!posts.length) return;
      const language = await getAdminLanguage({ from: { id: ADMIN_ID } }, client);
      for (const post of posts) await sendPreview(bot, post, client, language);
    });
  } catch (error) {
    console.error("[scheduler] processing error:", safeDiagnosticCode(error));
  }
}

function startBatch(bot) {
  if (!schedulerStopped && !activeBatch) {
    activeBatch = processScheduledPosts(bot).finally(() => { activeBatch = null; });
  }
}

async function updateAdminMessage(ctx, text) {
  try {
    await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } });
  } catch (error) {
    console.error("[scheduler] could not update admin message:", safeDiagnosticCode(error));
  }
}

async function handlePostAction(ctx) {
  const language = await getAdminLanguage(ctx);
  if (
    ctx.from?.id !== ADMIN_ID ||
    ctx.callbackQuery.message?.chat?.id !== ADMIN_ID
  ) {
    await ctx.answerCallbackQuery({
      text: adminText(language, "Unauthorized.", "دسترسی غیرمجاز است."),
      show_alert: true
    });
    return;
  }

  const match = ctx.callbackQuery.data.match(
    /^post_(approve|reject):(\d+)$/
  );

  if (!match) {
    await ctx.answerCallbackQuery({
      text: adminText(language, "Invalid action.", "عملیات نامعتبر است.")
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
          text: adminText(language, "Post is no longer available.", "این پست دیگر در دسترس نیست."),
          show_alert: true
        });
        return;
      }

      await ctx.answerCallbackQuery({
        text: adminText(language, "Post rejected.", "پست رد شد.")
      });

      await updateAdminMessage(
        ctx,
        adminText(language, "PROFINO — Post " + postId + " rejected.", "پروفینو — پست " + postId + " رد شد.")
      );
    } catch (error) {
      console.error("[scheduler] rejection error:", safeDiagnosticCode(error));

      await ctx.answerCallbackQuery({
        text: adminText(language, "Database error. Please try again.", "خطای پایگاه داده. دوباره تلاش کنید."),
        show_alert: true
      });
    }

    return;
  }

  return withSchedulerLock(true, client => publishApprovedPost(ctx, postId, language, client));
}

async function publishApprovedPost(ctx, postId, language, client) {
  let post;

  try {
    const result = await client.query(`
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
        text: adminText(language, "Post is no longer available.", "این پست دیگر در دسترس نیست."),
        show_alert: true
      });
      return;
    }

    post = result.rows[0];
  } catch (error) {
    console.error("[scheduler] approval database error:", safeDiagnosticCode(error));

    await ctx.answerCallbackQuery({
      text: adminText(language, "Database error. Nothing was published.", "خطای پایگاه داده؛ هیچ چیزی منتشر نشد."),
      show_alert: true
    });

    return;
  }

  try {
    await ctx.answerCallbackQuery({
      text: adminText(language, "Approval received. Publishing...", "تأیید دریافت شد. در حال انتشار...")
    });
  } catch (error) {
    // The approved post is already claimed. An expired callback does not undo that claim.
    console.error("[scheduler] approval acknowledgement failed:", safeDiagnosticCode(error));
  }

  let published;

  try {
    published = await ctx.api.sendMessage(
      CHANNEL_USERNAME,
      `${post.title}\n\n${post.content}`
    );
  } catch (error) {
    console.error(
      `[scheduler] publication result uncertain for post ${postId}:`,
      safeDiagnosticCode(error)
    );

    try {
      await client.query(`
        UPDATE scheduled_posts
        SET status = 'publish_unknown',
            updated_at = NOW()
        WHERE id = $1
          AND status = 'publishing'
      `, [postId]);
    } catch (databaseError) {
      console.error(
        "[scheduler] could not record publication uncertainty:",
      safeDiagnosticCode(databaseError)
    );
    }

    await updateAdminMessage(
      ctx,
      `PROFINO — Post ${postId}\n\n` +
      adminText(language, "Publication result is uncertain.\nCheck the channel before taking any further action.\nAutomatic retry is disabled.", "نتیجه انتشار نامشخص است.\nپیش از هر اقدام دیگری کانال را بررسی کنید.\nتلاش مجدد خودکار غیرفعال است.")
    );

    return;
  }

  try {
    await client.query(`
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
      adminText(language, "PROFINO — Post " + postId + " successfully published.\n\nChannel: " + CHANNEL_USERNAME + "\nMessage ID: " + published.message_id, "پروفینو — پست " + postId + " با موفقیت منتشر شد.\n\nکانال: " + CHANNEL_USERNAME + "\nشناسه پیام: " + published.message_id)
    );
  } catch (error) {
    console.error(
      `[scheduler] post ${postId} was sent, but database confirmation failed:`,
      safeDiagnosticCode(error)
    );

    await updateAdminMessage(
      ctx,
      adminText(language, "Post " + postId + " sent. Message ID: ", "پست " + postId + " ارسال شد. شناسه پیام: ") + published.message_id + "\n\n" +
      adminText(language, "Database confirmation failed.\nPlease verify the channel and database status manually.", "تأیید پایگاه داده ناموفق بود.\nوضعیت کانال و پایگاه داده را دستی بررسی کنید.")
    );
  }
}

export function startScheduler(bot) {
  if (isStarted) {
    return { ready: Promise.resolve(false), stop() {} };
  }

  isStarted = true;
  schedulerStopped = false;

  const activeActions = new Set();
  bot.callbackQuery(/^post_(approve|reject):\d+$/, async ctx => {
    if (schedulerStopped) return;
    const action = handlePostAction(ctx);
    activeActions.add(action);
    try {
      await action;
    } finally {
      activeActions.delete(action);
    }
  });

  const ready = recoverInterruptedOperations()
    .then(() => {
      if (schedulerStopped) return false;
      console.log("[scheduler] recovery completed.");

      startBatch(bot);

      schedulerTimer = setInterval(() => {
        startBatch(bot);
      }, CHECK_INTERVAL_MS);
      schedulerTimer.unref?.();

      console.log("[scheduler] scheduled-post system started.");
      return true;
    })
    .catch((error) => {
      console.error(
        "[scheduler] startup recovery failed. Scheduler remains disabled:",
      safeDiagnosticCode(error)
    );
      return false;
    });

  return {
    ready,
    async stop() {
      schedulerStopped = true;
      if (schedulerTimer) clearInterval(schedulerTimer);
      schedulerTimer = null;
      await ready;
      await Promise.all([activeBatch, Promise.allSettled(activeActions)]);
    }
  };
}
