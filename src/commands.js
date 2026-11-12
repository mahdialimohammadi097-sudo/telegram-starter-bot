
import { Keyboard } from "grammy";
import { randomBytes } from "node:crypto";
import { pool } from "./database.js";
import { getWalletBalances, getRecentWalletEntries } from "./wallet-balances.js";
import { formatUsdt } from "./ledger-safety.js";
import { adminText, getAdminLanguage } from "./admin-language.js";
import { safeDiagnosticCode } from "./diagnostic-safety.js";
import { clearPostManagementSession, registerPostManagement } from "./post-management.js";
import { clearPostHistorySession, registerPostHistory } from "./post-history.js";
import { registerAdminOps } from "./admin-ops.js";
import { createRateLimiter } from "./rate-limit.js";
import { buildReferralInviteLink } from "./referral-link.js";

const ADMIN_ID = 8810232463;
const CHANNEL_USERNAME = "@PROFINO1";
const ADMIN_TIME_ZONE = "UTC";

const adminDrafts = new Map();

const mainMenu = new Keyboard()
  .text("My Account").text("My Wallet").row()
  .text("Investment Plans").text("My Investments").row()
  .text("Deposit").text("Withdraw").row()
  .text("Daily Profits").text("Referral Program").row()
  .text("Transaction History").text("Support")
  .resized();

const backMenu = new Keyboard()
  .text("⬅ Main Menu")
  .resized();

async function getOrCreateUser(ctx) {
  const result = await pool.query(
    `INSERT INTO users
      (telegram_id, username, first_name, last_name, referral_code, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     ON CONFLICT (telegram_id)
     DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       referral_code = CASE WHEN NULLIF(btrim(users.referral_code), '') IS NULL
                            THEN EXCLUDED.referral_code ELSE users.referral_code END
     WHERE users.status = 'active'
     RETURNING id, telegram_id, username, first_name,
               last_name, referral_code, status, created_at`,
    [
      ctx.from.id,
      ctx.from.username ?? null,
      ctx.from.first_name ?? null,
      ctx.from.last_name ?? null,
      randomBytes(8).toString("hex")
    ]
  );

  return result.rows[0];
}

function isAdmin(ctx) {
  return ctx.from?.id === ADMIN_ID;
}

function isPrivateChat(ctx) {
  return ctx.chat?.type === "private";
}

function parseUtcDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (year < 2000 || month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute || date.getTime() <= Date.now() + 60000) return null;
  return date;
}

async function showScheduledPosts(ctx) {
  const result = await pool.query(
    `SELECT id, title, scheduled_at, status
     FROM scheduled_posts
     WHERE status IN (
       'scheduled',
       'preview_sending',
       'preview_sent',
       'preview_unknown',
       'approved',
       'publishing',
       'publish_unknown'
     )
     ORDER BY scheduled_at ASC
     LIMIT 20`
  );

  if (result.rowCount === 0) {
    return ctx.reply("No scheduled or pending posts found.");
  }

  const lines = result.rows.map(post => {
    const date = new Date(post.scheduled_at).toLocaleString(
      "en-GB",
      { timeZone: ADMIN_TIME_ZONE }
    );

    return [
      `ID: ${post.id}`,
      `Title: ${post.title}`,
      `Time: ${date}`,
      `Status: ${post.status.toUpperCase()}`
    ].join("\n");
  });

  return ctx.reply(
    "PROFINO — SCHEDULED POSTS\n\n" +
    lines.join("\n\n--------------------\n\n")
  );
}

export function registerCommands(bot) {
  const rateLimiter = createRateLimiter();
  // Keep all bot interactions private. This prevents group-based access-control
  // bypasses and avoids exposing account or administrative information in groups.
  // The owner account remains exempt from user-status checks.
  bot.use(async (ctx, next) => {
    if (!ctx.from) return;

    if (ctx.chat?.type !== "private") {
      if (ctx.callbackQuery) {
        return ctx.answerCallbackQuery({
          text: "Please use the bot in a private chat.",
          show_alert: true
        });
      }
      return;
    }

    const rate = rateLimiter.consume({
      userId: ctx.from.id,
      isAdmin: ctx.from.id === ADMIN_ID
    });

    if (!rate.allowed) {
      if (ctx.callbackQuery) {
        return ctx.answerCallbackQuery(rate.shouldNotify ? {
          text: "Too many requests. Please wait " + rate.retryAfterSeconds + "s.",
          show_alert: true
        } : {});
      }
      if (rate.shouldNotify && ctx.message) {
        return ctx.reply("You're sending requests too quickly. Please wait " + rate.retryAfterSeconds + " seconds.");
      }
      return;
    }

    if (ctx.from.id === ADMIN_ID) return next();

    try {
      const account = await pool.query(
        "SELECT status FROM users WHERE telegram_id = $1",
        [ctx.from.id]
      );

      if (account.rowCount && account.rows[0].status !== "active") {
        const message = "Your account is not active. Please contact support.";
        if (ctx.callbackQuery) {
          return ctx.answerCallbackQuery({ text: message, show_alert: true });
        }
        return ctx.reply(message);
      }
    } catch (error) {
      console.error("[access-control] status check failed:", safeDiagnosticCode(error));
      const message = "We cannot verify your account right now. Please try again later.";
      if (ctx.callbackQuery) {
        return ctx.answerCallbackQuery({ text: message, show_alert: true });
      }
      return ctx.reply(message);
    }

    return next();
  });

  registerPostManagement(bot);
  registerPostHistory(bot);
  registerAdminOps(bot);
  bot.command("start", async (ctx) => {
    try {
      const user = await getOrCreateUser(ctx);

      if (!user || user.status !== "active") {
        return ctx.reply(
          "Your account is not active. Please contact support."
        );
      }

      await ctx.reply(
        `Welcome to PROFINO, ${user.first_name ?? "User"}!\n\n` +
        "Your account is ready. Use the buttons below to continue.",
        { reply_markup: mainMenu }
      );
    } catch (error) {
      console.error("[registration] Failed:", safeDiagnosticCode(error));

      await ctx.reply(
        "Unable to load your account. Please try again later."
      );
    }
  });

  bot.command("help", async ctx => {
    if (!isAdmin(ctx) || !isPrivateChat(ctx)) return ctx.reply("Use the menu buttons to navigate PROFINO.");
    const language = await getAdminLanguage(ctx);
    const commands = [
      ["/admin", "Open the admin dashboard", "باز کردن داشبورد مدیریت"],
      ["/adminlanguage", "Choose the admin panel language (English/Persian)", "انتخاب زبان پنل مدیریت"],
      ["/planpreview <plan> <amount>", "Simulate a settlement in USDT", "شبیه‌سازی تسویه به USDT"],
      ["/adminstats", "View operations overview", "نمای کلی عملیات"],
      ["/user <telegram_id>", "Inspect a user", "مشاهده مشخصات کاربر"],
      ["/adminlogs", "View admin activity", "مشاهده فعالیت مدیر"],
      ["/dbschema", "Inspect core database tables (read-only)", "مشاهده ساختار جداول اصلی"],
      ["/adminschema", "Inspect admin membership and audit schema (read-only)", "مشاهده ساختار عضویت مدیر و ثبت فعالیت‌ها"],
      ["/newpost", "Create a scheduled post", "ساخت پست زمان‌بندی‌شده"],
      ["/scheduledposts", "View pending posts", "مشاهده پست‌های در انتظار"],
      ["/cancelpost", "Cancel the current draft", "لغو پیش‌نویس فعلی"],
      ["/channelcheck", "Verify channel permissions", "بررسی مجوزهای کانال"],
      ["/posthistory", "View all posts and history", "مشاهده تاریخچه پست‌ها"],
      ["/postdetails <id>", "View post details", "مشاهده جزئیات پست"],
    ];
    const heading = adminText(language, "ADMIN COMMANDS", "دستورهای مدیریت");
    const lines = commands.map(([command, en, fa]) => command + " - " + adminText(language, en, fa));
    return ctx.reply([heading, ...lines].join("\n"));
  });

  bot.command("id", (ctx) =>
    ctx.reply(`Your Telegram ID: ${ctx.from?.id ?? "Unknown"}`)
  );

  bot.command("channelcheck", async (ctx) => {
    if (!isAdmin(ctx) || !isPrivateChat(ctx)) {
      return ctx.reply("Access denied.");
    }

    const language = await getAdminLanguage(ctx);
    try {
      const chat = await ctx.api.getChat(CHANNEL_USERNAME);
      const me = await ctx.api.getMe();
      const member = await ctx.api.getChatMember(chat.id, me.id);

      const isChannelAdmin =
        member.status === "creator" ||
        (
          member.status === "administrator" &&
          member.can_post_messages === true
        );

      if (!isChannelAdmin) {
        return ctx.reply(
          adminText(language, "Channel access found, but posting permission is not confirmed.", "کانال در دسترس است. مجوز انتشار پست تأیید نشده است.")
        );
      }

      return ctx.reply(
        adminText(language, "PROFINO CHANNEL CONNECTION\n\n" +
        "Channel: @PROFINO1\n" +
        "Bot status: Administrator\n" +
        "Posting permission: Confirmed\n\n" +
        "Connection test successful.", "اتصال به کانال PROFINO\n\nکانال: @PROFINO1\nمجوز انتشار پست تأیید شد.")
      );
    } catch (error) {
      console.error("[channel] Check failed:", safeDiagnosticCode(error));

      return ctx.reply(
        adminText(language, "Channel connection failed. Please check the bot permissions.", "بررسی اتصال کانال ممکن نشد. مجوزهای ربات را بررسی کنید.")
      );
    }
  });

  // Start creating a scheduled post.
  bot.command("newpost", async (ctx) => {
    if (!isAdmin(ctx) || !isPrivateChat(ctx)) {
      return ctx.reply(
        "This command is available only to the administrator in private chat."
      );
    }

    clearPostManagementSession(ADMIN_ID);
    adminDrafts.set(ADMIN_ID, {
      step: "title",
      title: null,
      content: null
    });

    return ctx.reply(
      "PROFINO — NEW POST\n\n" +
      "Step 1 of 3\n\n" +
      "Send the post title in English.\n\n" +
      "Maximum length: 255 characters.\n\n" +
      "Send /cancelpost to cancel."
    );
  });

  // Cancel the current draft.
  bot.command("cancelpost", async (ctx) => {
    if (!isAdmin(ctx) || !isPrivateChat(ctx)) {
      return ctx.reply("Access denied.");
    }

    const existed = adminDrafts.delete(ADMIN_ID);
    const managementExisted = clearPostManagementSession(ADMIN_ID);
    const historyExisted = clearPostHistorySession(ADMIN_ID);

    return ctx.reply(
      existed || managementExisted || historyExisted
        ? "Current post operation cancelled."
        : "There is no active post draft or edit session."
    );
  });

  // Display pending posts.
  bot.command("scheduledposts", async (ctx) => {
    if (!isAdmin(ctx) || !isPrivateChat(ctx)) {
      return ctx.reply("Access denied.");
    }

    try {
      await showScheduledPosts(ctx);
    } catch (error) {
      console.error("[scheduled-posts] Failed:", safeDiagnosticCode(error));

      await ctx.reply(
        "Unable to retrieve scheduled posts. Please try again."
      );
    }
  });

  bot.on("message:text", async (ctx) => {
    const choice = ctx.message.text;
    const userId = ctx.from.id;

    // Only the administrator can continue a post draft.
    if (isAdmin(ctx) && isPrivateChat(ctx) && adminDrafts.has(userId)) {
      const draft = adminDrafts.get(userId);

      if (choice.startsWith("/")) {
        return;
      }

      if (draft.step === "title") {
        const title = choice.trim();

        if (!title || title.length > 255) {
          return ctx.reply(
            "Invalid title. Please send a title between 1 and 255 characters."
          );
        }

        draft.title = title;
        draft.step = "content";

        return ctx.reply(
          "Step 2 of 3\n\n" +
          "Send the complete post content in English.\n\n" +
          "Maximum length: 3500 characters."
        );
      }

      if (draft.step === "content") {
        const content = choice.trim();

        if (!content || content.length > 3500) {
          return ctx.reply(
            "Invalid content. Please send between 1 and 3500 characters."
          );
        }

        draft.content = content;
        draft.step = "scheduled_at";

        return ctx.reply(
          "Step 3 of 3\n\n" +
          "Send the scheduled date and time in UTC.\n\n" +
          "Required format:\n" +
          "YYYY-MM-DD HH:mm\n\n" +
          "Example:\n" +
          "2026-11-12 18:30"
        );
      }

      if (draft.step === "scheduled_at") {
        const scheduledAt = parseUtcDateTime(choice.trim());

        if (!scheduledAt) {
          return ctx.reply(
            "Invalid date or time.\n\n" +
            "Use YYYY-MM-DD HH:mm in UTC.\n" +
            "The scheduled time must be at least one minute in the future."
          );
        }

        try {
          const result = await pool.query(
            `INSERT INTO scheduled_posts
              (title, content, scheduled_at, status)
             VALUES ($1, $2, $3, 'scheduled')
             RETURNING id, title, scheduled_at`,
            [
              draft.title,
              draft.content,
              scheduledAt.toISOString()
            ]
          );

          const post = result.rows[0];

          adminDrafts.delete(userId);

          const formattedTime = new Date(
            post.scheduled_at
          ).toLocaleString("en-GB", {
            timeZone: ADMIN_TIME_ZONE,
            dateStyle: "medium",
            timeStyle: "short"
          });

          return ctx.reply(
            "PROFINO — POST SCHEDULED\n\n" +
            `Post ID: ${post.id}\n` +
            `Title: ${post.title}\n` +
            `Scheduled time: ${formattedTime} UTC\n` +
            "Status: SCHEDULED\n\n" +
            "The bot will send you a private preview at the scheduled time.\n\n" +
            "Nothing will be published until you approve it."
          );
        } catch (error) {
          console.error("[newpost] Database error:", safeDiagnosticCode(error));

          return ctx.reply(
            "Unable to save the post.\n" +
            "Your draft is still available. Please try again."
          );
        }
      }
    }

    if (choice === "⬅ Main Menu") {
      return ctx.reply("Main Menu", {
        reply_markup: mainMenu
      });
    }

    if (choice === "My Account") {
      try {
        const result = await pool.query(
          `SELECT id, telegram_id, username, first_name,
                  last_name, referral_code, status, created_at
           FROM users
           WHERE telegram_id = $1`,
          [userId]
        );

        if (result.rowCount === 0) {
          return ctx.reply(
            "Please send /start to register first."
          );
        }

        const account = result.rows[0];

        return ctx.reply(
          "MY ACCOUNT\n\n" +
          `Account ID: ${account.id}\n` +
          `Telegram ID: ${account.telegram_id}\n` +
          `Username: ${account.username ? "@" + account.username : "Not set"}\n` +
          `Name: ${account.first_name ?? ""} ${account.last_name ?? ""}\n` +
          `Status: ${account.status.toUpperCase()}\n` +
          `Referral Code: ${account.referral_code}\n` +
          `Joined: ${new Date(account.created_at).toLocaleDateString("en-GB")}`,
          { reply_markup: backMenu }
        );
      } catch (error) {
        console.error("[account] Failed:", safeDiagnosticCode(error));

        return ctx.reply(
          "Unable to load account information. Please try again later."
        );
      }
    }

    if (choice === "Referral Program") {
      try {
        const result = await pool.query(
          "SELECT referral_code FROM users WHERE telegram_id = $1 LIMIT 1",
          [userId]
        );

        if (!result.rowCount) {
          return ctx.reply("Please send /start to register first.", {
            reply_markup: backMenu
          });
        }

        const referralCode = result.rows[0].referral_code;
        if (!referralCode?.trim()) {
          return ctx.reply("Send /start to generate your invite link, then open Referral Program again.", {
            reply_markup: backMenu
          });
        }
        const inviteLink = buildReferralInviteLink(referralCode);

        return ctx.reply(
          "REFERRAL PROGRAM\n\n" +
          `Your referral code: ${referralCode}\n` +
          `Your invite link: ${inviteLink}\n\n` +
          "Referral tracking and rewards are not enabled yet. Sharing this link does not create a reward or financial transaction.",
          { reply_markup: backMenu }
        );
      } catch (error) {
        console.error("[referral] Failed to build invite link:", safeDiagnosticCode(error));
        return ctx.reply(
          "Unable to load your referral link right now. Please try again later.",
          { reply_markup: backMenu }
        );
      }
    }

    if (choice === "My Wallet" || choice === "Transaction History") {
      try {
        const userResult = await pool.query(
          `SELECT id FROM users WHERE telegram_id = $1`,
          [userId]
        );

        if (userResult.rowCount === 0) {
          return ctx.reply(
            "Please send /start to register first."
          );
        }

        if (choice === "Transaction History") {
          const entries = await getRecentWalletEntries(pool, userResult.rows[0].id);
          const lines = entries.map(entry => {
            const utc = entry.created_at.toISOString().slice(0, 16).replace("T", " ");
            const sign = entry.entry_type === "credit" ? "+" : "-";
            return utc + " UTC · " + entry.account_type + " · " + sign + formatUsdt(entry.amount) + " USDT";
          });
          const summary = lines.length ? "Latest posted wallet entries (up to 10)\n" + lines.join("\n") : "No posted wallet entries yet.";
          return ctx.reply("TRANSACTION HISTORY\n\n" + summary, { reply_markup: backMenu });
        }

        const balances = await getWalletBalances(pool, userResult.rows[0].id);

        const format = formatUsdt;

        return ctx.reply(
          "MY WALLET\n\n" +
          `Available Balance: ${format(balances.AVAILABLE)} USDT\n` +
          `Invested Balance: ${format(balances.INVESTED)} USDT\n` +
          `Recorded Profit: ${format(balances.PROFIT)} USDT\n\n` +
          "Balances reflect posted ledger transactions only.",
          { reply_markup: backMenu }
        );
      } catch (error) {
        console.error("[wallet] Failed:", safeDiagnosticCode(error));

        return ctx.reply(
          choice === "Transaction History" ? "Unable to load transaction history. Please try again later." : "Unable to load wallet balances. Please try again later.",
          { reply_markup: backMenu }
        );
      }
    }

    const sections = {
      "Investment Plans":
        "INVESTMENT PLANS\n\nAvailable plans will appear here after configuration and verification.",

      "My Investments":
        "MY INVESTMENTS\n\nYour active investments will appear here.",

      "Deposit":
        "DEPOSIT\n\nAutomatic deposit verification is not enabled yet. Do not send funds until an official deposit address is displayed.",

      "Withdraw":
        "WITHDRAW\n\nWithdrawal services are not enabled yet.",

      "Daily Profits":
        "DAILY PROFITS\n\nVerified profit records will appear here when available.",


      "Support":
        "SUPPORT\n\nPlease contact our support team."
    };

    if (sections[choice]) {
      return ctx.reply(sections[choice], {
        reply_markup: backMenu
      });
    }
  });
                              }
    
