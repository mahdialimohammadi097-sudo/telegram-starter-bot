import { InlineKeyboard } from "grammy";
import { pool } from "./database.js";

const ADMIN_ID = 8810232463;
const sessions = new Map();

function previewKeyboard(postId) {
  return new InlineKeyboard()
    .text("Approve & Publish", \`post_approve:\${postId}\`)
    .text("Reject", \`post_reject:\${postId}\`)
    .row()
    .text("Edit Post", \`post_edit:\${postId}\`)
    .text("Reschedule", \`post_time:\${postId}\`)
    .row()
    .text("Cancel Post", \`post_cancel:\${postId}\`);
}

function parseUtcDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);

  if (y < 2000 || mo < 1 || mo > 12 || h > 23 || mi > 59) return null;

  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi
  ) return null;

  if (date.getTime() <= Date.now() + 60_000) return null;
  return date;
}

async function getCurrentPreview(ctx, postId) {
  const message = ctx.callbackQuery?.message;
  if (
    ctx.from?.id !== ADMIN_ID ||
    message?.chat?.type !== "private" ||
    Number(message.chat.id) !== ADMIN_ID
  ) return null;

  const result = await pool.query(
    \`SELECT id, title, content, scheduled_at, edit_version,
            preview_message_id, preview_chat_id
     FROM scheduled_posts
     WHERE id = $1
       AND status = 'preview_sent'
       AND preview_message_id = $2
       AND preview_chat_id = $3\`,
    [postId, message.message_id, message.chat.id]
  );

  return result.rows[0] ?? null;
}

async function invalidateOldPreview(ctx, chatId, messageId, text) {
  try {
    await ctx.api.editMessageText(chatId, messageId, text);
  } catch (error) {
    console.error("[post-management] could not invalidate old preview:", error);
  }
}

function utcLabel(date) {
  return new Date(date).toLocaleString("en-GB", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short"
  }) + " UTC";
}

export function clearPostManagementSession(userId) {
  sessions.delete(userId);
}

export function registerPostManagement(bot) {
  bot.callbackQuery(/^post_edit:\d+$/, async (ctx) => {
    const postId = ctx.callbackQuery.data.split(":")[1];
    try {
      const post = await getCurrentPreview(ctx, postId);
      if (!post) {
        await ctx.answerCallbackQuery({ text: "This preview is no longer valid.", show_alert: true });
        return;
      }

      const keyboard = new InlineKeyboard()
        .text("Edit Title", \`post_edit_title:\${postId}\`)
        .text("Edit Content", \`post_edit_content:\${postId}\`)
        .row()
        .text("Back", \`post_edit_back:\${postId}\`);

      await ctx.answerCallbackQuery();
      await ctx.reply(
        \`EDIT POST #\${postId}\\n\\nChoose which field you want to change. The existing preview will become invalid after you save the edit.\`,
        { reply_markup: keyboard }
      );
    } catch (error) {
      console.error("[post-management] edit menu failed:", error);
      await ctx.answerCallbackQuery({ text: "Unable to open edit options.", show_alert: true });
    }
  });

  for (const field of ["title", "content"]) {
    bot.callbackQuery(new RegExp(\`^post_edit_\${field}:\\\\d+$\`), async (ctx) => {
      const postId = ctx.callbackQuery.data.split(":")[1];
      try {
        const post = await getCurrentPreview(ctx, postId);
        if (!post) {
          await ctx.answerCallbackQuery({ text: "This preview is no longer valid.", show_alert: true });
          return;
        }

        sessions.set(ADMIN_ID, {
          postId: String(post.id),
          field,
          editVersion: post.edit_version,
          previewMessageId: post.preview_message_id,
          previewChatId: post.preview_chat_id
        });

        await ctx.answerCallbackQuery();
        await ctx.reply(
          field === "title"
            ? \`Send the new title for post #\${postId} (1–255 characters). Send /cancelpost to stop.\`
            : \`Send the new content for post #\${postId} (1–3500 characters). Send /cancelpost to stop.\`
        );
      } catch (error) {
        console.error("[post-management] edit session failed:", error);
        await ctx.answerCallbackQuery({ text: "Unable to start editing.", show_alert: true });
      }
    });
  }

  bot.callbackQuery(/^post_edit_back:\d+$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const postId = ctx.callbackQuery.data.split(":")[1];
      await ctx.api.editMessageReplyMarkup(
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.message.message_id,
        { reply_markup: previewKeyboard(postId) }
      );
    } catch (error) {
      console.error("[post-management] could not restore preview controls:", error);
    }
  });

  bot.callbackQuery(/^post_time:\d+$/, async (ctx) => {
    const postId = ctx.callbackQuery.data.split(":")[1];
    try {
      const post = await getCurrentPreview(ctx, postId);
      if (!post) {
        await ctx.answerCallbackQuery({ text: "This preview is no longer valid.", show_alert: true });
        return;
      }

      sessions.set(ADMIN_ID, {
        postId: String(post.id),
        field: "scheduled_at",
        editVersion: post.edit_version,
        previewMessageId: post.preview_message_id,
        previewChatId: post.preview_chat_id
      });

      await ctx.answerCallbackQuery();
      await ctx.reply(
        \`RESCHEDULE POST #\${postId}\\n\\nSend the new date and time in UTC using this exact format:\\nYYYY-MM-DD HH:mm\\n\\nExample: 2026-11-12 15:30\\n\\nThe time must be at least one minute in the future. Send /cancelpost to stop.\`
      );
    } catch (error) {
      console.error("[post-management] reschedule session failed:", error);
      await ctx.answerCallbackQuery({ text: "Unable to start rescheduling.", show_alert: true });
    }
  });

  bot.callbackQuery(/^post_cancel:\d+$/, async (ctx) => {
    const postId = ctx.callbackQuery.data.split(":")[1];
    try {
      const post = await getCurrentPreview(ctx, postId);
      if (!post) {
        await ctx.answerCallbackQuery({ text: "This preview is no longer valid.", show_alert: true });
        return;
      }

      const keyboard = new InlineKeyboard()
        .text("Confirm Cancellation", \`post_cancel_confirm:\${postId}\`)
        .text("Keep Post", \`post_cancel_back:\${postId}\`);

      await ctx.answerCallbackQuery();
      await ctx.reply(
        \`CANCEL POST #\${postId}\\n\\nAre you sure? This action cannot be undone from the bot.\`,
        { reply_markup: keyboard }
      );
    } catch (error) {
      console.error("[post-management] cancel confirmation failed:", error);
      await ctx.answerCallbackQuery({ text: "Unable to open cancellation confirmation.", show_alert: true });
    }
  });

  bot.callbackQuery(/^post_cancel_back:\d+$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Post kept." });
  });

  bot.callbackQuery(/^post_cancel_confirm:\d+$/, async (ctx) => {
    const postId = ctx.callbackQuery.data.split(":")[1];
    try {
      const post = await getCurrentPreview(ctx, postId);
      if (!post) {
        await ctx.answerCallbackQuery({ text: "This preview is no longer valid.", show_alert: true });
        return;
      }

      const result = await pool.query(
        \`UPDATE scheduled_posts
         SET status = 'cancelled',
             cancelled_at = NOW(),
             cancellation_reason = 'Cancelled by administrator',
             preview_message_id = NULL,
             preview_chat_id = NULL,
             approved_by = NULL,
             edit_version = edit_version + 1,
             updated_at = NOW()
         WHERE id = $1
           AND status = 'preview_sent'
           AND preview_message_id = $2
           AND preview_chat_id = $3
           AND edit_version = $4
         RETURNING id\`,
        [postId, post.preview_message_id, post.preview_chat_id, post.edit_version]
      );

      if (!result.rowCount) {
        await ctx.answerCallbackQuery({ text: "Post changed or is no longer available.", show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery({ text: "Post cancelled." });
      await invalidateOldPreview(
        ctx,
        post.preview_chat_id,
        post.preview_message_id,
        \`PROFINO — Post #\${postId} was cancelled by the administrator.\`
      );
    } catch (error) {
      console.error("[post-management] cancellation failed:", error);
      await ctx.answerCallbackQuery({ text: "Unable to cancel this post.", show_alert: true });
    }
  });

  // Intercept only active administrator edit/reschedule sessions; pass all other text to normal commands.
  bot.on("message:text", async (ctx, next) => {
    if (ctx.from?.id !== ADMIN_ID || ctx.chat?.type !== "private") return next();

    const session = sessions.get(ADMIN_ID);
    if (!session) return next();

    const value = ctx.message.text.trim();
    if (value.startsWith("/")) return next();

    if (session.field === "title" && (!value || value.length > 255)) {
      await ctx.reply("Invalid title. Please send 1–255 characters, or /cancelpost.");
      return;
    }

    if (session.field === "content" && (!value || value.length > 3500)) {
      await ctx.reply("Invalid content. Please send 1–3500 characters, or /cancelpost.");
      return;
    }

    let scheduledAt = null;
    if (session.field === "scheduled_at") {
      scheduledAt = parseUtcDateTime(value);
      if (!scheduledAt) {
        await ctx.reply(
          "Invalid UTC date/time. Use YYYY-MM-DD HH:mm, choose a real calendar date, and set it at least one minute in the future. Or send /cancelpost."
        );
        return;
      }
    }

    try {
      let result;

      if (session.field === "scheduled_at") {
        result = await pool.query(
          \`UPDATE scheduled_posts
           SET scheduled_at = $1,
               status = 'scheduled',
               preview_message_id = NULL,
               preview_chat_id = NULL,
               approved_by = NULL,
               edit_version = edit_version + 1,
               last_edited_at = NOW(),
               updated_at = NOW()
           WHERE id = $2
             AND status = 'preview_sent'
             AND preview_message_id = $3
             AND preview_chat_id = $4
             AND edit_version = $5
           RETURNING id, scheduled_at\`,
          [scheduledAt.toISOString(), session.postId, session.previewMessageId, session.previewChatId, session.editVersion]
        );
      } else {
        const column = session.field === "title" ? "title" : "content";
        result = await pool.query(
          \`UPDATE scheduled_posts
           SET \${column} = $1,
               scheduled_at = GREATEST(scheduled_at, NOW() + INTERVAL '1 minute'),
               status = 'scheduled',
               preview_message_id = NULL,
               preview_chat_id = NULL,
               approved_by = NULL,
               edit_version = edit_version + 1,
               last_edited_at = NOW(),
               updated_at = NOW()
           WHERE id = $2
             AND status = 'preview_sent'
             AND preview_message_id = $3
             AND preview_chat_id = $4
             AND edit_version = $5
           RETURNING id, scheduled_at\`,
          [value, session.postId, session.previewMessageId, session.previewChatId, session.editVersion]
        );
      }

      sessions.delete(ADMIN_ID);

      if (!result.rowCount) {
        await ctx.reply("This preview is no longer current. No changes were saved. Open the latest preview to try again.");
        return;
      }

      await invalidateOldPreview(
        ctx,
        session.previewChatId,
        session.previewMessageId,
        \`PROFINO — Preview for post #\${session.postId} is no longer valid. The post was updated and returned to the schedule.\`
      );

      const savedTime = utcLabel(result.rows[0].scheduled_at);
      await ctx.reply(
        \`Post #\${session.postId} updated successfully.\\nStatus: SCHEDULED\\nScheduled time: \${savedTime}\\n\\nA new private preview will be sent at the scheduled time. Publishing still requires your approval.\`
      );
    } catch (error) {
      console.error("[post-management] saving change failed:", error);
      await ctx.reply("Unable to save the change. Please try again or send /cancelpost.");
    }
  });
}
