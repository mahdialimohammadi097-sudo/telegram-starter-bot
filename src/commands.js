
import { InlineKeyboard } from "grammy"

const ADMIN_ID = 8810232463

export function registerCommands(bot) {
  bot.command("start", (ctx) =>
    ctx.reply(`Hi ${ctx.from?.first_name ?? "there"}. I am alive and hosted on FadeHost. Send /help to see what I can do.`, {
      reply_markup: new InlineKeyboard().text("Ping me", "ping"),
    }),
  )

  bot.command("help", (ctx) =>
    ctx.reply([
      "Commands:",
      "/start - say hello",
      "/help - this list",
      "/ping - check bot",
      "/id - show your ID",
      "/admin - admin panel",
    ].join("\n")),
  )

  bot.command("ping", (ctx) => ctx.reply("pong"))

  bot.command("id", (ctx) =>
    ctx.reply(`Chat id: ${ctx.chat.id}\nYour id: ${ctx.from?.id ?? "unknown"}`),
  )

  bot.command("admin", (ctx) => {
    if (ctx.from?.id !== ADMIN_ID) {
      return ctx.reply("Access denied.")
    }

    return ctx.reply("Welcome to the admin panel!")
  })

  bot.callbackQuery("ping", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "pong" })
  })

  bot.on("message:text", (ctx) => ctx.reply(ctx.message.text))
}
