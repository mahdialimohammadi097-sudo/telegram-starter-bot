// PROFINO Telegram Bot
// Telegram updates are received through polling by default.

import http from "node:http"
import { Bot, webhookCallback } from "grammy"
import { registerCommands } from "./src/commands.js"
import { testDatabaseConnection } from "./src/database.js"

const token = process.env.TELEGRAM_BOT_TOKEN

if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is missing.")
  process.exit(1)
}

const mode = (process.env.TELEGRAM_MODE || "polling").trim().toLowerCase()
const bot = new Bot(token)

registerCommands(bot)

bot.catch((err) => {
  console.error("[bot] error while handling an update:", err.error ?? err)
})

function explain(err) {
  const code = err?.error_code ?? err?.response?.error_code

  if (code === 401) {
    console.error("[bot] Telegram rejected the token (401 Unauthorized).")
  } else if (code === 404) {
    console.error("[bot] Telegram answered 404. Check the bot token.")
  } else {
    console.error("[bot] could not reach Telegram:", err?.message ?? err)
  }
}

async function main() {
  // Test PostgreSQL connection.
  try {
    const result = await testDatabaseConnection()
    console.log("[database] PostgreSQL connected successfully.")
    console.log("[database] server time:", result.server_time)
  } catch (err) {
    console.error("[database] connection test failed:", err?.message ?? err)
    console.error("[database] Telegram bot will continue running.")
  }

  let me

  try {
    me = await bot.api.getMe()
  } catch (err) {
    explain(err)
    process.exit(1)
  }

  console.log(`[bot] logged in as @${me.username} (${mode} mode)`)

  if (mode === "webhook") {
    const url = (process.env.WEBHOOK_URL || "").trim().replace(/\/$/, "")

    if (!url.startsWith("https://")) {
      console.error("[bot] WEBHOOK_URL is missing or invalid.")
      process.exit(1)
    }

    const secret = (process.env.WEBHOOK_SECRET || "").trim() || undefined
    const port = Number(process.env.PORT || 3000)
    const handle = webhookCallback(bot, "http", { secretToken: secret })

    http
      .createServer((req, res) => {
        if (req.method === "POST" && req.url === "/telegram") {
          return handle(req, res)
        }

        if (req.method === "GET" && req.url === "/") {
          res.writeHead(200, { "content-type": "text/plain" })
          return res.end(`@${me.username} is running`)
        }

        res.writeHead(404)
        res.end()
      })
      .listen(port, () => {
        console.log(`[bot] webhook server listening on port ${port}`)
      })

    await bot.api.setWebhook(`${url}/telegram`, {
      secret_token: secret,
    })

    console.log(`[bot] webhook set to ${url}/telegram`)
    return
  }

  // Polling mode.
  await bot.api.deleteWebhook().catch(() => {})

  let wait = 20
  let waitingForOther = false

  for (;;) {
    const began = Date.now()
    let settled

    try {
      await bot.start({
        onStart: () => {
          if (!waitingForOther) {
            console.log("[bot] polling for updates")
            return
          }

          settled = setTimeout(() => {
            waitingForOther = false
            wait = 20
            console.log("[bot] this bot is now receiving updates")
          }, 45_000)
        },
      })

      return
    } catch (err) {
      clearTimeout(settled)

      const code = err?.error_code ?? err?.response?.error_code

      if (code === 401 || code === 404) {
        explain(err)
        process.exit(1)
      }

      if (Date.now() - began > 120_000) {
        wait = 20
        waitingForOther = false
      }

      if (code === 409) {
        if (!waitingForOther) {
          console.error(
            "[bot] another copy is running with the same token."
          )
          waitingForOther = true
        }
      } else {
        console.error("[bot] polling stopped:", err?.message ?? err)
      }

      console.error(`[bot] trying again in ${wait} seconds`)

      await new Promise((resolve) => setTimeout(resolve, wait * 1000))

      wait = Math.min(wait * 2, 300)
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.log(`[bot] ${signal}, stopping`)
    bot.stop().finally(() => process.exit(0))
  })
}

main()
