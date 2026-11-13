import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function runUntilShutdown(t, clientSetup, { signalOn, mode = "polling" } = {}) {
  const root = new URL("../", import.meta.url);
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  // Patch only the external clients in the child. Run the actual entry point and signal handler.
  const preload = `
    import { createRequire } from "node:module";
    const require = createRequire(process.cwd() + "/package.json");
    const { Bot, Api } = require("grammy");
    const pg = require("pg");
    ${clientSetup}
  `;
  const child = spawn(process.execPath, ["--unhandled-rejections=strict", "--import",
    "data:text/javascript," + encodeURIComponent(preload), "index.js"], {
    cwd: fileURLToPath(root),
    env: { ...process.env, PORT: String(port), TELEGRAM_MODE: mode,
      WEBHOOK_URL: "https://example.invalid", WEBHOOK_SECRET: "fixture",
      TELEGRAM_BOT_TOKEN: "offline", DATABASE_URL: "postgres://localhost/offline" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let log = "";
  let signalled = false;
  function capture(data) {
    log += data;
    if (signalOn && !signalled && log.includes(signalOn)) {
      signalled = true;
      child.kill("SIGTERM");
    }
  }
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const [code, signal] = await once(child, "close");
  if (signalOn) assert.ok(signalled, log);
  assert.equal(signal, null, log);
  assert.equal(code, 0, log);
  return log;
}

test("SIGTERM drains asynchronous Telegram shutdown during a database startup outage", { timeout: 12000 }, async t => {
  const log = await runUntilShutdown(t, `
    pg.Pool.prototype.query = async () => { throw new Error("offline database"); };
    Bot.prototype.stop = async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      throw new Error("offline Telegram shutdown");
    };
  `, { signalOn: "retrying PostgreSQL connection" });
  assert.ok(log.indexOf("Telegram bot stop warning") >= 0, log);
  assert.ok(log.indexOf("PostgreSQL pool closed") > log.indexOf("Telegram bot stop warning"), log);
});

for (const stage of ["database", "authentication", "startup report", "delete webhook", "register webhook"]) {
  test("SIGTERM prevents startup from resuming after " + stage, { timeout: 12000 }, async t => {
    const log = await runUntilShutdown(t, `
      const stage = ${JSON.stringify(stage)};
      let stopped = false;
      let finishStop;
      const stopStarted = new Promise(resolve => { finishStop = resolve; });
      async function operation(name) {
        if (stopped) console.error("LATE OPERATION:", name);
        if (name === stage && !stopped) {
          process.kill(process.pid, "SIGTERM");
          await stopStarted;
        }
      }
      Bot.prototype.stop = async () => { stopped = true; finishStop(); };
      Bot.prototype.start = async () => { await operation("start polling"); };
      pg.Pool.prototype.query = async sql => {
        if (sql.includes("AS server_time")) {
          await operation("database");
          return { rows: [{ server_time: new Date() }] };
        }
        await operation("SQL query");
        return { rows: [] };
      };
      pg.Pool.prototype.connect = async () => { throw new Error("offline scheduler"); };
      Api.prototype.getMe = async () => { await operation("authentication"); return { id: 7, username: "fixture" }; };
      Api.prototype.sendMessage = async () => { await operation("startup report"); };
      Api.prototype.deleteWebhook = async () => { await operation("delete webhook"); };
      Api.prototype.setWebhook = async () => { await operation("register webhook"); };
      Api.prototype.getWebhookInfo = async () => ({ url: "https://example.invalid/telegram" });
    `, { mode: stage === "register webhook" ? "webhook" : "polling" });
    assert.match(log, /SIGTERM: stopping/);
    assert.match(log, /PostgreSQL pool closed/);
    assert.doesNotMatch(log, /LATE OPERATION|webhook registered|could not start/);
  });
}
