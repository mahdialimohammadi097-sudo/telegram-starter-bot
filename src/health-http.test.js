import http from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Bot } from "grammy";
import { webhookConfiguration, telegramWebhookHandler } from "./telegram-webhook.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeHealthState } from "./runtime-health.js";
import { startHealthHttpServer } from "./health-http.js";

test("health endpoints distinguish liveness from dependency readiness", async (t) => {
  const runtimeHealth = createRuntimeHealthState();
  const server = await startHealthHttpServer({
    port: 0,
    runtimeHealth,
    getBotUsername: () => "PROFINO_TEST"
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const live = await fetch(base + "/livez");
  assert.equal(live.status, 200);
  assert.equal(await live.text(), "alive");

  const notReady = await fetch(base + "/healthz");
  assert.equal(notReady.status, 503);
  assert.equal((await notReady.json()).ready, false);

  runtimeHealth.setDatabaseReady(true);
  runtimeHealth.setTelegramApiConnected(true);
  runtimeHealth.setTelegramReceiverActive(true);

  const recovering = await fetch(base + "/healthz");
  assert.equal(recovering.status, 503);
  assert.equal((await recovering.json()).scheduler, "unavailable");
  runtimeHealth.setSchedulerReady(true);

  const ready = await fetch(base + "/healthz");
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).ready, true);

  const root = await fetch(base + "/");
  assert.equal(root.status, 200);
  assert.equal(await root.text(), "@PROFINO_TEST is running");
});

test("webhook route is unavailable until a handler is registered", async (t) => {
  const runtimeHealth = createRuntimeHealthState();
  let handler = null;
  const server = await startHealthHttpServer({
    port: 0,
    runtimeHealth,
    getWebhookHandler: () => handler
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const unavailable = await fetch(base + "/telegram", { method: "POST" });
  assert.equal(unavailable.status, 503);

  handler = (_req, res) => {
    res.writeHead(200);
    res.end("accepted");
  };
  const accepted = await fetch(base + "/telegram", { method: "POST" });
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), "accepted");
});

test("webhook configuration requires a valid secret and HTTPS base", () => {
  for (const token of [undefined, "", "bad.token", "bad\n", "x".repeat(257)]) {
    assert.throws(() => webhookConfiguration("https://example.invalid", token), /Invalid WEBHOOK_SECRET/);
  }
  for (const url of ["http://example.invalid", "https://", "https://user@example.invalid", "https://example.invalid/?key=x"]) {
    assert.throws(() => webhookConfiguration(url, "fixture"), /Invalid WEBHOOK_URL/);
  }
  assert.equal(webhookConfiguration("https://example.invalid/bot/", "fixture").url, "https://example.invalid/bot/telegram");
});

test("HTTP webhook rejects forged updates and recovers after invalid JSON", async t => {
  const bot = new Bot("offline", { botInfo: { id: 7, is_bot: true, first_name: "Test", username: "fixture_bot" } });
  const seen = [];
  bot.use(ctx => { seen.push(ctx.update.update_id); });
  const config = webhookConfiguration("https://example.invalid", "fixture-only");
  const handler = telegramWebhookHandler(bot, config);
  const server = await startHealthHttpServer({ port: 0, runtimeHealth: createRuntimeHealthState(), getWebhookHandler: () => handler });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = "http://127.0.0.1:" + server.address().port + "/telegram";
  const post = (secret, body) => fetch(endpoint, { method: "POST", body,
    headers: secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {} });
  for (const token of [null, "incorrect"]) {
    assert.equal((await post(token, '{"update_id":123}')).status, 401);
  }
  assert.deepEqual(seen, []);
  assert.equal((await post(config.secret, "{")).status, 500);
  assert.equal((await post(config.secret, '{"update_id":124}')).status, 200);
  assert.deepEqual(seen, [124]);
});

test("the registered public webhook path and proxy-stripped route both deliver updates", async t => {
  const config = webhookConfiguration("https://example.invalid/bot/", "fixture");
  const pathname = new URL(config.url).pathname;
  const delivered = [];
  const bot = new Bot("offline", { botInfo: { id: 7, is_bot: true, first_name: "Fixture", username: "fixture_bot" } });
  bot.use(ctx => { delivered.push(ctx.update.update_id); });
  const handler = telegramWebhookHandler(bot, config);
  const server = await startHealthHttpServer({ port: 0, runtimeHealth: createRuntimeHealthState(),
    webhookPath: pathname, getWebhookHandler: () => handler });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (path, id, secret = config.secret) => fetch("http://127.0.0.1:" + server.address().port + path, {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify({ update_id: id })
  });
  assert.equal((await post(pathname, 1)).status, 200);
  assert.equal((await post("/telegram", 2)).status, 200);
  assert.equal((await post("/other/telegram", 3)).status, 404);
  assert.equal((await post(pathname, 4, "wrong")).status, 401);
  assert.deepEqual(delivered, [1, 2]);
});

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("HTTP shutdown releases an unfinished webhook body without waiting for the sender", { timeout: 4000 }, async t => {
  const started = gate();
  const server = await startHealthHttpServer({
    port: 0, runtimeHealth: createRuntimeHealthState(),
    getWebhookHandler: () => async req => {
      started.resolve();
      for await (const chunk of req) void chunk;
    }
  });
  const client = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/telegram", method: "POST" });
  client.on("error", () => {});
  t.after(() => { client.destroy(); server.closeAllConnections(); server.close(); });
  client.write('{"update_id":');
  await started.promise;
  await server.drain();
  assert.equal(server.listening, false);
});

test("HTTP shutdown waits for accepted webhook work after the sender disconnects", { timeout: 4000 }, async t => {
  const started = gate();
  const finish = gate();
  const disconnected = gate();
  let calls = 0;
  const server = await startHealthHttpServer({
    port: 0, runtimeHealth: createRuntimeHealthState(),
    getWebhookHandler: () => async (req, res) => {
      calls++;
      res.once("close", disconnected.resolve);
      for await (const chunk of req) void chunk;
      started.resolve();
      await finish.promise;
    }
  });
  const client = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/telegram", method: "POST" });
  client.on("error", () => {});
  t.after(() => { finish.resolve(); client.destroy(); server.closeAllConnections(); server.close(); });
  client.end('{"update_id":1}');
  await started.promise;
  client.destroy();
  await disconnected.promise;
  let drained = false;
  const stopping = server.drain().then(() => { drained = true; });
  await nextTurn();
  assert.equal(drained, false);
  finish.resolve();
  await stopping;
  assert.equal(calls, 1);
});
