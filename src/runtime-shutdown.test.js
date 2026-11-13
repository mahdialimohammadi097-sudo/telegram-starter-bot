import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("SIGTERM drains asynchronous Telegram shutdown during a database startup outage", { timeout: 12000 }, async t => {
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
    const { Bot } = require("grammy");
    const pg = require("pg");
    pg.Pool.prototype.query = async () => { throw new Error("offline database"); };
    Bot.prototype.stop = async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      throw new Error("offline Telegram shutdown");
    };
  `;
  const child = spawn(process.execPath, ["--unhandled-rejections=strict", "--import",
    "data:text/javascript," + encodeURIComponent(preload), "index.js"], {
    cwd: fileURLToPath(root),
    env: { ...process.env, PORT: String(port), TELEGRAM_MODE: "polling",
      TELEGRAM_BOT_TOKEN: "offline", DATABASE_URL: "postgres://localhost/offline" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let log = "";
  let signalled = false;
  function capture(data) {
    log += data;
    if (!signalled && log.includes("retrying PostgreSQL connection")) {
      signalled = true;
      child.kill("SIGTERM");
    }
  }
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const [code, signal] = await once(child, "close");
  assert.ok(signalled, log);
  assert.equal(signal, null, log);
  assert.equal(code, 0, log);
  assert.ok(log.indexOf("Telegram bot stop warning") >= 0, log);
  assert.ok(log.indexOf("PostgreSQL pool closed") > log.indexOf("Telegram bot stop warning"), log);
});
