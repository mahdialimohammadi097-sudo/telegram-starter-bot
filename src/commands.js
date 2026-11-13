import { listPreviewPlans, settlementExamples } from "./plan-preview.js";
import { parseUtcDateTime, postStatusLabel } from "./post-schedule.js";

import { InlineKeyboard, Keyboard } from "grammy";
import { randomBytes } from "node:crypto";
import { pool } from "./database.js";
import { getWalletBalances, getSimulationReceipt, getSimulatedTransferActivity, getDailySimulatedProfits, getSimulatedInvestmentActivity, getWalletHistoryPage, IncompleteWalletError } from "./wallet-balances.js";
import { formatUsdt, toUsdtUnitsExact } from "./ledger-safety.js";
import { adminText, getAdminLanguage } from "./admin-language.js";
import { safeDiagnosticCode } from "./diagnostic-safety.js";
import { clearPostManagementSession, registerPostManagement } from "./post-management.js";
import { clearPostHistorySession, registerPostHistory } from "./post-history.js";
import { registerAdminOps } from "./admin-ops.js";
import { createRateLimiter } from "./rate-limit.js";
import { buildReferralInviteLink, normalizeReferralCode } from "./referral-link.js";

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

const simulationHistoryLabels = new Map([
  ["simulated-deposit", "Simulated deposit"],
  ["simulated-investment-open", "Simulated investment opened"],
  ["simulated-investment-settle", "Simulated settlement"],
  ["sim-withdraw-reserve", "Simulated withdrawal reserved"],
  ["sim-withdraw-release", "Simulated withdrawal cancelled"]
]);

const backMenu = new Keyboard()
  .text("⬅ Main Menu")
  .resized();

async function getOrCreateUser(ctx) {
  const result = await pool.query(
    `WITH registered AS (
       INSERT INTO users
        (telegram_id, username, first_name, last_name, referral_code, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       ON CONFLICT (telegram_id)
       DO UPDATE SET
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         referral_code = CASE WHEN users.referral_code IS NULL OR users.referral_code !~* '^[[:space:]]*[0-9a-f]{16}[[:space:]]*$'
                              THEN EXCLUDED.referral_code ELSE users.referral_code END
       WHERE users.status = 'active'
       RETURNING id, telegram_id, username, first_name,
                 last_name, referral_code, status, created_at
     ), wallet_setup AS (
       INSERT INTO ledger_accounts (user_id, account_code, account_type, currency)
       SELECT u.id, 'user:' || u.id || ':USDT:' || kind, kind, 'USDT'
       FROM registered u CROSS JOIN unnest(ARRAY['AVAILABLE', 'INVESTED', 'PROFIT']) AS kind
       ON CONFLICT (user_id, account_type, currency) DO NOTHING
     )
     SELECT * FROM registered`,
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


async function showScheduledPosts(ctx, language) {
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
    return ctx.reply(adminText(language, "No scheduled or pending posts found.", "پستی در صف زمان‌بندی یا تأیید نیست."));
  }

  const lines = result.rows.map(post => {
    const date = new Date(post.scheduled_at).toLocaleString(
      "en-GB",
      { timeZone: ADMIN_TIME_ZONE }
    );

    return [
      adminText(language, "ID: ", "شناسه: ") + post.id,
      adminText(language, "Title: ", "عنوان: ") + post.title,
      adminText(language, "Time: ", "زمان: ") + date + " UTC",
      adminText(language, "Status: ", "وضعیت: ") + postStatusLabel(post.status, language)
    ].join("\n");
  });
  const heading = adminText(language, "PROFINO — SCHEDULED POSTS", "پست‌های زمان‌بندی‌شده");
  let page = heading;
  for (const line of lines) {
    if (page.length + line.length + 2 > 4096) {
      await ctx.reply(page);
      page = heading;
    }
    page += "\n\n" + line;
  }
  return ctx.reply(page);
}

export function registerCommands(bot, { openTestInvestment, inspectTestQueue, reserveTestWithdrawal, cancelTestWithdrawal, listTestHolds, testWithdrawalReview } = {}) {
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

  // Only the offline test harness supplies a simulation writer.
  if (openTestInvestment) {
    bot.callbackQuery(/^sim_open:([A-Z]+):(\d+)$/, async ctx => {
      const [, name, amount] = ctx.match;
      if (!settlementExamples(name).some(example => example.amount === amount) || !ctx.callbackQuery.message) {
        return ctx.answerCallbackQuery({ text: "Invalid simulation selection.", show_alert: true });
      }
      const { rows: [user] } = await pool.query(
        "SELECT id FROM users WHERE telegram_id = $1 AND status = 'active'", [ctx.from.id]
      );
      if (!user) return ctx.answerCallbackQuery({ text: "Send /start first.", show_alert: true });
      const key = "telegram-preview:" + ctx.callbackQuery.message.message_id;
      await ctx.answerCallbackQuery();
      try {
        const id = await openTestInvestment(user.id, key, name + " " + amount);
        return ctx.reply("Simulation confirmed · Investment #" + id + "\nOpen My Investments to see the posted entry.", {
          reply_markup: new Keyboard().text("My Investments").text("My Wallet").row().text("⬅ Main Menu").resized()
        });
      } catch (error) {
        console.error("[simulation] opening failed:", safeDiagnosticCode(error));
        return ctx.reply("Unable to open this simulation. Check My Investments and your test balance before trying again.");
      }
    });
  }

  if (reserveTestWithdrawal) {
    bot.command("testwithdraw", async ctx => {
      const amount = ctx.match.trim();
      if (!/^\d{1,18}(?:\.\d{1,8})?$/.test(amount) || toUsdtUnitsExact(amount) === 0n) {
        return ctx.reply("Use /testwithdraw followed by a positive test USDT amount with up to 8 decimal places.");
      }
      const normalized = formatUsdt(amount);
      const key = ctx.message.message_id;
      return ctx.reply("Simulation only · Reserve " + normalized + " test USDT from your available balance?", {
        reply_markup: new InlineKeyboard().text("Confirm test reservation", "sim_hold:" + key + ":" + normalized)
      });
    });
    bot.callbackQuery(/^sim_hold:([1-9]\d{0,9}):(\d{1,18}\.\d{8})$/, async ctx => {
      await ctx.answerCallbackQuery();
      try {
        const { rows: [user] } = await pool.query(
          "SELECT id FROM users WHERE telegram_id = $1 AND status = 'active'", [ctx.from.id]
        );
        if (!user) return ctx.reply("Send /start first.");
        const [, messageId, amount] = ctx.match;
        const request = await reserveTestWithdrawal(user.id, "telegram-withdraw:" + messageId, amount);
        return ctx.reply("Simulated withdrawal #" + request.id + " is " + request.status + ".", {
          reply_markup: new Keyboard().text("Withdraw").text("My Wallet").row().text("⬅ Main Menu").resized()
        });
      } catch (error) {
        if (error.message === "Insufficient available balance") return ctx.reply("Insufficient available test balance.");
        console.error("[simulation] withdrawal reservation failed:", safeDiagnosticCode(error));
        return ctx.reply("Unable to reserve the test amount. Check Withdraw and My Wallet before trying again.");
      }
    });
  }

  if (cancelTestWithdrawal) {
    bot.callbackQuery(/^sim_cancel_hold:([1-9]\d{0,18})$/, async ctx => {
      await ctx.answerCallbackQuery();
      try {
        const { rows: [user] } = await pool.query(
          "SELECT id FROM users WHERE telegram_id = $1 AND status = 'active'", [ctx.from.id]
        );
        if (!user) return ctx.reply("Send /start first.");
        const id = ctx.match[1];
        await cancelTestWithdrawal(user.id, id);
        return ctx.reply("Simulated withdrawal #" + id + " is cancelled. Open My Wallet to see your available balance.");
      } catch (error) {
        console.error("[simulation] withdrawal cancellation failed:", safeDiagnosticCode(error));
        return ctx.reply("Unable to cancel this simulated withdrawal. Open Withdraw to check its status.");
      }
    });
  }

  async function showSimulationReceipt(ctx, id) {
    if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
      return ctx.reply("Use /receipt followed by the journal number shown in Deposit or Withdraw.");
    }
    try {
      const receipt = await getSimulationReceipt(pool, ctx.from.id, id);
      if (!receipt) return ctx.reply("No matching simulation receipt is available.");
      return ctx.reply([
        "SIMULATION RECEIPT · " + simulationHistoryLabels.get(receipt.transaction_type),
        "Request #" + receipt.reference_id + " · Journal #" + receipt.id,
        "Amount: " + formatUsdt(receipt.amount) + " test USDT",
        "Posted: " + receipt.created_at.toISOString()
      ].join("\n"), { reply_markup: new Keyboard().text("Deposit").text("Withdraw").row().text("⬅ Main Menu").resized() });
    } catch (error) {
      console.error("[receipt] lookup failed:", safeDiagnosticCode(error));
      return ctx.reply("Unable to load your receipt. Please try again later.");
    }
  }
  bot.command("receipt", ctx => showSimulationReceipt(ctx, ctx.match.trim()));
  bot.hears(/^\/receipt_([1-9]\d{0,18})$/, ctx => showSimulationReceipt(ctx, ctx.match[1]));

  registerPostManagement(bot);
  registerPostHistory(bot);
  registerAdminOps(bot, { inspectTestQueue, testWithdrawalReview });
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
    if (!isAdmin(ctx) || !isPrivateChat(ctx)) return ctx.reply("Use the menu buttons to navigate PROFINO.", { reply_markup: mainMenu });
    const language = await getAdminLanguage(ctx);
    const commands = [
      ["/admin", "Open the admin dashboard", "باز کردن داشبورد مدیریت"],
      ["/adminlanguage", "Choose the admin panel language (English/Persian)", "انتخاب زبان پنل مدیریت"],
      ...(testWithdrawalReview ? [["/reviewhold [id]", "List or review test withdrawals", "فهرست و بازبینی برداشت‌های آزمایشی"]] : []),
      ...(inspectTestQueue ? [["/simqueue", "Inspect the simulated settlement queue", "بررسی صف تسویه آزمایشی"]] : []),
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

    const language = await getAdminLanguage(ctx);
    clearPostManagementSession(ADMIN_ID);
    clearPostHistorySession(ADMIN_ID);
    adminDrafts.set(ADMIN_ID, {
      step: "title",
      title: null,
      content: null
    });

    return ctx.reply(
      adminText(language, "PROFINO — NEW POST\n\n" +
      "Step 1 of 3\n\n" +
      "Send the post title in English.\n\n" +
      "Maximum length: 255 characters.\n\n" +
      "Send /cancelpost to cancel.",
        "پست جدید · مرحله ۱ از ۳\n\nعنوان انگلیسی پست را بفرستید (حداکثر ۲۵۵ نویسه). برای لغو، /cancelpost را بفرستید.")
    );
  });

  // Cancel the current draft.
  bot.command("cancelpost", async (ctx) => {
    if (!isAdmin(ctx) || !isPrivateChat(ctx)) {
      return ctx.reply("Access denied.");
    }

    const language = await getAdminLanguage(ctx);
    const existed = adminDrafts.delete(ADMIN_ID);
    const managementExisted = clearPostManagementSession(ADMIN_ID);
    const historyExisted = clearPostHistorySession(ADMIN_ID);

    return ctx.reply(
      existed || managementExisted || historyExisted
        ? adminText(language, "Current post operation cancelled.", "عملیات جاری پست لغو شد.")
        : adminText(language, "There is no active post draft or edit session.", "پیش‌نویس یا ویرایش فعالی وجود ندارد.")
    );
  });

  // Display pending posts.
  bot.command("scheduledposts", async (ctx) => {
    if (!isAdmin(ctx) || !isPrivateChat(ctx)) {
      return ctx.reply("Access denied.");
    }

    const language = await getAdminLanguage(ctx);
    try {
      await showScheduledPosts(ctx, language);
    } catch (error) {
      console.error("[scheduled-posts] Failed:", safeDiagnosticCode(error));

      await ctx.reply(
        adminText(language, "Unable to retrieve scheduled posts. Please try again.", "دریافت فهرست پست‌ها ممکن نشد. دوباره تلاش کنید.")
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

      const language = await getAdminLanguage(ctx);
      if (draft.step === "title") {
        const title = choice.trim();

        if (!title || title.length > 255) {
          return ctx.reply(
            adminText(language, "Invalid title. Please send a title between 1 and 255 characters.",
            "عنوان باید بین ۱ تا ۲۵۵ نویسه باشد.")
          );
        }

        draft.title = title;
        draft.step = "content";

        return ctx.reply(
          adminText(language, "Step 2 of 3\n\n" +
          "Send the complete post content in English.\n\n" +
          "Maximum length: 3500 characters.",
            "مرحله ۲ از ۳\n\nمتن کامل پست را به انگلیسی بفرستید (حداکثر ۳۵۰۰ نویسه).")
        );
      }

      if (draft.step === "content") {
        const content = choice.trim();

        if (!content || content.length > 3500) {
          return ctx.reply(
            adminText(language, "Invalid content. Please send between 1 and 3500 characters.",
            "متن پست باید بین ۱ تا ۳۵۰۰ نویسه باشد.")
          );
        }

        draft.content = content;
        draft.step = "scheduled_at";

        return ctx.reply(
          adminText(language, "Step 3 of 3\n\n" +
          "Send the scheduled date and time in UTC.\n\n" +
          "Required format:\n" +
          "YYYY-MM-DD HH:mm",
            "مرحله ۳ از ۳\n\nتاریخ میلادی و ساعت را به وقت UTC و با قالب YYYY-MM-DD HH:mm بفرستید.")
        );
      }

      if (draft.step === "scheduled_at") {
        const scheduledAt = parseUtcDateTime(choice.trim());

        if (!scheduledAt) {
          return ctx.reply(
            adminText(language, "Invalid date or time.\n\n" +
            "Use YYYY-MM-DD HH:mm in UTC.\n" +
            "The scheduled time must be at least one minute in the future.",
            "تاریخ یا ساعت معتبر نیست. زمان باید دست‌کم یک دقیقه در آینده و با قالب YYYY-MM-DD HH:mm به وقت UTC باشد.")
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
            adminText(language, "PROFINO — POST SCHEDULED\n\n" +
            `Post ID: ${post.id}\n` +
            `Title: ${post.title}\n` +
            `Scheduled time: ${formattedTime} UTC\n` +
            "Status: SCHEDULED\n\n" +
            "The bot will send you a private preview at the scheduled time.\n\n" +
            "Nothing will be published until you approve it.",
            `پست زمان‌بندی شد\n\nشناسه: ${post.id}\nعنوان: ${post.title}\nزمان: ${formattedTime} UTC\n\nدر زمان مقرر، پیش‌نمایش خصوصی برای شما ارسال می‌شود. انتشار به تأیید شما نیاز دارد.`)
          );
        } catch (error) {
          console.error("[newpost] Database error:", safeDiagnosticCode(error));

          return ctx.reply(
            adminText(language, "Unable to save the post.\n" +
            "Your draft is still available. Please try again.",
            "ذخیره پست ممکن نشد. پیش‌نویس شما موجود است؛ دوباره تلاش کنید.")
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
          `Referral Code: ${normalizeReferralCode(account.referral_code) || "Send /start to generate a code."}\n` +
          `Joined: ${new Date(account.created_at).toLocaleDateString("en-GB")}`,
          { reply_markup: new Keyboard().text("Referral Program").text("My Wallet").row().text("⬅ Main Menu").resized() }
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

        const referralCode = normalizeReferralCode(result.rows[0].referral_code);
        if (!referralCode) {
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

    const olderPage = /^Older entries · #(\d{1,19})$/.exec(choice);
    if (olderPage && BigInt(olderPage[1]) > 9223372036854775807n) {
      return ctx.reply("Open Transaction History to see your latest entries.", { reply_markup: mainMenu });
    }
    const transferScreen = choice === "Deposit" || choice === "Withdraw";
    if (transferScreen || choice === "My Wallet" || choice === "Transaction History" || choice === "My Investments" || choice === "Daily Profits" || olderPage) {
      const walletMenu = new Keyboard()
        .text(choice === "My Wallet" ? "Transaction History" : "My Wallet")
        .row().text("⬅ Main Menu").resized();
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

        if (transferScreen) {
          const activity = await getSimulatedTransferActivity(pool, userResult.rows[0].id, choice);
          const lines = activity.map(row => {
            const time = row.created_at.toISOString().slice(0, 16).replace("T", " ");
            const action = simulationHistoryLabels.get(row.transaction_type);
            return time + " UTC · " + action + " · #" + row.reference_id + " · " + formatUsdt(row.amount) + " test USDT · /receipt_" + row.journal_id;
          });
          const availability = choice === "Deposit" ? "Real deposits are disabled. Do not send funds." : "Real withdrawals are disabled.";
          const summary = lines.length ? "Latest posted activity (up to 10)\n" + lines.join("\n") : "No posted simulation activity yet.";
          let keyboard = walletMenu;
          if (choice === "Withdraw" && cancelTestWithdrawal && listTestHolds) {
            const controls = new InlineKeyboard();
            const holds = await listTestHolds(userResult.rows[0].id);
            for (const hold of holds) {
              controls.text("Cancel test withdrawal #" + hold.id + " · " + formatUsdt(hold.amount) + " USDT",
                "sim_cancel_hold:" + hold.id).row();
            }
            if (controls.inline_keyboard.some(row => row.length)) keyboard = controls;
          }
          const instructions = choice === "Withdraw" && reserveTestWithdrawal ? "\n\nTo preview a reservation, send /testwithdraw followed by the test USDT amount." : "";
          return ctx.reply(choice.toUpperCase() + " · SIMULATION\n\n" + availability + instructions + "\n\n" + summary, { reply_markup: keyboard });
        }
        if (choice === "Daily Profits") {
          const days = await getDailySimulatedProfits(pool, userResult.rows[0].id);
          const lines = days.map(day => day.day + " UTC · " + formatUsdt(day.net_profit) + " test USDT · " +
            day.settlements + (day.settlements === 1 ? " settlement" : " settlements"));
          const body = lines.length ? "Net profit after fees, by settlement date (latest 10 dates)\n" + lines.join("\n")
            : "No simulated settlements yet.";
          return ctx.reply("DAILY PROFITS · SIMULATION\n\n" + body, {
            reply_markup: new Keyboard().text("My Investments").text("My Wallet").row().text("⬅ Main Menu").resized()
          });
        }

        if (choice === "My Investments") {
          const activity = await getSimulatedInvestmentActivity(pool, userResult.rows[0].id);
          const lines = activity.map(row => {
            const opened = row.transaction_type === "simulated-investment-open";
            const date = row.created_at.toISOString().slice(0, 16).replace("T", " ");
            const heading = date + " UTC · Investment #" + row.reference_id + (opened ? " opened" : " settled");
            const principal = "Principal: " + formatUsdt(row.principal) + " test USDT";
            const payout = row.payout === null ? "" : "\nCredited to wallet: " + formatUsdt(row.payout) + " test USDT";
            return heading + "\n" + principal + payout;
          });
          const body = lines.length ? "Latest posted activity (up to 10)\n\n" + lines.join("\n\n") : "No simulated investment activity yet.";
          return ctx.reply("MY INVESTMENTS · SIMULATION\n\n" + body, {
            reply_markup: new Keyboard().text("Investment Plans").text("My Wallet").row().text("⬅ Main Menu").resized()
          });
        }
        if (choice !== "My Wallet") {
          const { entries, next } = await getWalletHistoryPage(pool, userResult.rows[0].id, olderPage?.[1]);
          if (next) walletMenu.row().text("Older entries · #" + next);
          if (olderPage) walletMenu.row().text("Transaction History");
          const lines = entries.map(entry => {
            const utc = entry.created_at.toISOString().slice(0, 16).replace("T", " ");
            const sign = entry.entry_type === "credit" ? "+" : "-";
            const account = entry.account_type === "WITHDRAWAL_HOLD" ? "Reserved for withdrawal" : entry.account_type;
            const label = simulationHistoryLabels.get(entry.transaction_type);
            const line = utc + " UTC · " + account + " · " + sign + formatUsdt(entry.amount) + " USDT";
            if (!label) return line;
            const receipt = entry.has_receipt ? " · /receipt_" + entry.journal_id : "";
            return line + " · " + label + receipt;
          });
          const heading = olderPage ? "Older posted wallet entries" : "Latest posted wallet entries (up to 10)";
          const empty = olderPage ? "No older entries available." : "No posted wallet entries yet.";
          const summary = lines.length ? heading + "\n" + lines.join("\n") : empty;
          return ctx.reply("TRANSACTION HISTORY\n\n" + summary, { reply_markup: walletMenu });
        }

        const balances = await getWalletBalances(pool, userResult.rows[0].id);

        const format = formatUsdt;

        return ctx.reply(
          "MY WALLET\n\n" +
          `Available Balance: ${format(balances.AVAILABLE)} USDT\n` +
          `Invested Balance: ${format(balances.INVESTED)} USDT\n` +
          (balances.WITHDRAWAL_HOLD !== undefined ? `Reserved for Withdrawal: ${format(balances.WITHDRAWAL_HOLD)} USDT\n` : "") +
          `Recorded Profit: ${format(balances.PROFIT)} USDT\n\n` +
          "Balances reflect posted ledger transactions only.",
          { reply_markup: walletMenu }
        );
      } catch (error) {
        if (error instanceof IncompleteWalletError) {
          return ctx.reply("Your account is registered. Send /start to complete wallet setup, then open My Wallet again.", {
            reply_markup: new Keyboard().text("My Wallet").row().text("⬅ Main Menu").resized()
          });
        }
        console.error("[wallet] Failed:", safeDiagnosticCode(error));
        if (transferScreen) return ctx.reply("Unable to load simulated transfer activity. Please try again later.", {
          reply_markup: new Keyboard().text(choice).row().text("⬅ Main Menu").resized()
        });
        if (choice === "Daily Profits" || choice === "My Investments") return ctx.reply(
          choice === "Daily Profits" ? "Unable to load daily profits. Please try again later." : "Unable to load investment activity. Please try again later.", {
          reply_markup: new Keyboard().text(choice).row().text("⬅ Main Menu").resized()
        });

        return ctx.reply(
          choice !== "My Wallet" ? "Unable to load transaction history. Please try again later." : "Unable to load wallet balances. Please try again later.",
          { reply_markup: new Keyboard().text(choice).row().text("⬅ Main Menu").resized() }
        );
      }
    }

    if (choice === "Investment Plans") {
      const keyboard = new Keyboard();
      const terms = listPreviewPlans().map(plan => {
        keyboard.text("Preview " + plan.name).row();
        return plan.name + " · " + plan.days + " days";
      });
      keyboard.text("⬅ Main Menu").resized();
      return ctx.reply(["INVESTMENT PLANS · SIMULATION", ...terms,
        "Select a plan to see example settlements using test USDT."].join("\n\n"), { reply_markup: keyboard });
    }

    if (choice.startsWith("Preview ")) {
      const examples = settlementExamples(choice.slice("Preview ".length));
      if (examples.length) {
        const plan = examples[0];
        const lines = examples.map(row =>
          row.amount + " → " + row.gross + " − " + row.fee + " = " + row.payout
        );
        let keyboard = new Keyboard().text("Investment Plans").row().text("⬅ Main Menu").resized();
        if (openTestInvestment) {
          keyboard = new InlineKeyboard();
          for (const example of examples) {
            keyboard.text("Open with " + example.amount + " test USDT", "sim_open:" + plan.name + ":" + example.amount).row();
          }
        }
        return ctx.reply([
          plan.name + " · SIMULATION ONLY",
          "Term: " + plan.days + " days. Example profit: " + plan.profitPercent + "%.",
          "Settlement fee: " + plan.feePercent + "% of principal plus profit.",
          "Test USDT: principal → gross − fee = net settlement",
          ...lines,
          "Viewing examples does not open an investment or move funds."
        ].join("\n"), { reply_markup: keyboard });
      }
    }

    if (choice === "Support") {
      const keyboard = new Keyboard().text("My Account").text("Referral Program").row()
        .text("My Wallet").text("Transaction History").row().text("⬅ Main Menu").resized();
      return ctx.reply("SUPPORT\n\nSend /start to create or reopen your account.\n" +
        "Choose My Wallet to check your balance, or Transaction History to see recent entries.\n" +
        "Choose Referral Program to find your invite link.", { reply_markup: keyboard });
    }

    if (!choice.startsWith("/") && !isAdmin(ctx)) {
      return ctx.reply("Choose an option from the main menu below.", { reply_markup: mainMenu });
    }
  });
                              }
    
