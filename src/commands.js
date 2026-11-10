
import { Keyboard } from "grammy";
import { randomBytes } from "node:crypto";
import { pool } from "./database.js";

const ADMIN_ID = 8810232463;
const CHANNEL_USERNAME = "@PROFINO1";
const ADMIN_TIME_ZONE = "Asia/Tehran";

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
       last_name = EXCLUDED.last_name
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

async function getWalletBalances(userId) {
  const result = await pool.query(
    `SELECT
       la.account_type,
       COALESCE(
         SUM(
           CASE
             WHEN le.entry_type = 'credit' THEN le.amount
             WHEN le.entry_type = 'debit' THEN -le.amount
             ELSE 0
           END
         ), 0
       ) AS balance
     FROM ledger_accounts la
     LEFT JOIN ledger_entries le
       ON le.account_id = la.id
      AND le.transaction_id IN (
        SELECT id
        FROM ledger_transactions
        WHERE status = 'posted'
      )
     WHERE la.user_id = $1
       AND la.currency = 'USDT'
     GROUP BY la.account_type
     ORDER BY la.account_type`,
    [userId]
  );

  const balances = {
    AVAILABLE: null,
    INVESTED: null,
    PROFIT: null
  };

  for (const row of result.rows) {
    if (Object.hasOwn(balances, row.account_type)) {
      balances[row.account_type] = row.balance;
    }
  }

  if (Object.values(balances).some(value => value === null)) {
    throw new Error("Wallet accounts are incomplete");
  }

  return balances;
}

function isAdmin(ctx) {
  return ctx.from?.id === ADMIN_ID;
}

function isPrivateChat(ctx) {
  return ctx.chat?.type === "private";
}

function parseTehranDateTime(value) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/
  );

  if (!match) return null;

  const [, year, month, day, hour, minute] = match;

  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);

  if (
    mo < 1 || mo > 12 ||
    d < 1 || d > 31 ||
    h < 0 || h > 23 ||
    mi < 0 || mi > 59
  ) {
    return null;
  }

  const iso = `${year}-${month}-${day}T${hour}:${minute}:00+03:30`;
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ADMIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  if (
    values.year !== year ||
    values.month !== month ||
    values.day !== day ||
    values.hour !== hour ||
    values.minute !== minute
  ) {
    return null;
  }

  if (date.getTime() <= Date.now() + 60_000) {
    return null;
  }

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
  bot.command("start", async (ctx) => {
    try {
      const user = await getOrCreateUser(ctx);

      if (user.status !== "active") {
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
      console.error("[registration] Failed:", error.message);

      await ctx.reply(
        "Unable to load your account. Please try again later."
      );
    }
  });

  bot.command("help", (ctx) => {
    const userHelp =
      "Use the menu buttons to navigate PROFINO.";

    const adminHelp =
      "\n\nADMIN COMMANDS\n" +
      "/newpost - Create a scheduled post\n" +
      "/scheduledposts - View pending posts\n" +
      "/cancelpost - Cancel the current draft\n" +
      "/channelcheck - Verify channel permissions";

    return ctx.reply(
      userHelp + (isAdmin(ctx) ? adminHelp : "")
    );
  });

  bot.command("id", (ctx) =>
    ctx.reply(`Your Telegram ID: ${ctx.from?.id ?? "Unknown"}`)
  );

  bot.command("admin", (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply("Access denied.");
    }

    return ctx.reply(
      "PROFINO Admin Panel\n\n" +
      "Admin access confirmed.\n\n" +
      "Available commands:\n" +
      "/newpost\n" +
      "/scheduledposts\n" +
      "/cancelpost\n" +
      "/channelcheck"
    );
  });

  bot.command("channelcheck", async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply("Access denied.");
    }

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
          "Channel access found, but posting permission is not confirmed."
        );
      }

      return ctx.reply(
        "PROFINO CHANNEL CONNECTION\n\n" +
        "Channel: @PROFINO1\n" +
        "Bot status: Administrator\n" +
        "Posting permission: Confirmed\n\n" +
        "Connection test successful."
      );
    } catch (error) {
      console.error("[channel] Check failed:", error.message);

      return ctx.reply(
        "Channel connection failed. Please check the bot permissions."
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

    return ctx.reply(
      existed
        ? "Post creation cancelled."
        : "There is no active post draft."
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
      console.error("[scheduled-posts] Failed:", error);

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
          "Send the scheduled date and time in Tehran time.\n\n" +
          "Required format:\n" +
          "YYYY-MM-DD HH:mm\n\n" +
          "Example:\n" +
          "2026-11-12 18:30"
        );
      }

      if (draft.step === "scheduled_at") {
        const scheduledAt = parseTehranDateTime(choice.trim());

        if (!scheduledAt) {
          return ctx.reply(
            "Invalid date or time.\n\n" +
            "Use YYYY-MM-DD HH:mm in Tehran time.\n" +
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
            `Scheduled time: ${formattedTime} (Tehran)\n` +
            "Status: SCHEDULED\n\n" +
            "The bot will send you a private preview at the scheduled time.\n\n" +
            "Nothing will be published until you approve it."
          );
        } catch (error) {
          console.error("[newpost] Database error:", error);

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
        console.error("[account] Failed:", error.message);

        return ctx.reply(
          "Unable to load account information. Please try again later."
        );
      }
    }

    if (choice === "My Wallet") {
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

        const balances = await getWalletBalances(
          userResult.rows[0].id
        );

        const format = value => Number(value).toFixed(8);

        return ctx.reply(
          "MY WALLET\n\n" +
          `Available Balance: ${format(balances.AVAILABLE)} USDT\n` +
          `Invested Balance: ${format(balances.INVESTED)} USDT\n` +
          `Recorded Profit: ${format(balances.PROFIT)} USDT\n\n` +
          "Balances reflect posted ledger transactions only.",
          { reply_markup: backMenu }
        );
      } catch (error) {
        console.error("[wallet] Failed:", error.message);

        return ctx.reply(
          "Unable to load wallet balances. Please try again later.",
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

      "Referral Program":
        "REFERRAL PROGRAM\n\nYour referral details will appear here.",

      "Transaction History":
        "TRANSACTION HISTORY\n\nYour transaction records will appear here.",

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
          
