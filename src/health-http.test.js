import http from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { Bot, webhookCallback } from "grammy";
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

test("webhook handler failures do not expose details or terminate health server", async (t) => {
  const runtimeHealth = createRuntimeHealthState();
  let handler = () => { throw new Error("synthetic-sensitive-detail"); };
  const server = await startHealthHttpServer({
    port: 0, runtimeHealth, getWebhookHandler: () => handler
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const failure of [
    () => { throw new Error("synthetic-sensitive-detail"); },
    async () => { throw new Error("synthetic-sensitive-detail"); }
  ]) {
    handler = failure;
    const response = await fetch(base + "/telegram", { method: "POST" });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "internal server error");
    const live = await fetch(base + "/livez");
    assert.equal(live.status, 200);
    await live.text();
  }
  handler = (_req, res) => res.end("accepted");
  const recovered = await fetch(base + "/telegram", { method: "POST" });
  assert.equal(recovered.status, 200);
  assert.equal(await recovered.text(), "accepted");
});

test("real grammY HTTP adapter rejects unauthenticated updates before dispatch", async (t) => {
  const runtimeHealth = createRuntimeHealthState();
  const dispatched = [];
  const bot = new Bot("123456:synthetic-test-token");
  // No external API requests or real Telegram credentials are used.
  bot.init = async () => {};
  bot.handleUpdate = async (update) => { dispatched.push(update.update_id); };
  const handler = webhookCallback(bot, "http", { secretToken: "synthetic-test-secret" });
  const server = await startHealthHttpServer({
    port: 0, runtimeHealth, getWebhookHandler: () => handler
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/telegram`;
  async function send(id, secret) {
    const headers = { "content-type": "application/json" };
    if (secret !== undefined) headers["x-telegram-bot-api-secret-token"] = secret;
    const response = await fetch(endpoint, {
      method: "POST", headers, body: JSON.stringify({ update_id: id })
    });
    await response.text();
    return response.status;
  }
  assert.equal(await send(1), 401);
  assert.equal(await send(2, "incorrect"), 401);
  assert.deepEqual(dispatched, []);
  assert.equal(await send(3, "synthetic-test-secret"), 200);
  assert.deepEqual(dispatched, [3]);
});

test("configured webhook path and proxy-stripped path authenticate consistently", async (t) => {
  const seen = [];
  const bot = new Bot("123456:synthetic-test-token");
  bot.init = async () => {};
  bot.handleUpdate = async update => { seen.push(update.update_id); };
  const handler = webhookCallback(bot, "http", { secretToken: "synthetic-test-secret" });
  const server = await startHealthHttpServer({
    port: 0, runtimeHealth: createRuntimeHealthState(),
    webhookPath: "/bot/telegram", getWebhookHandler: () => handler
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function send(path, id, secret = "synthetic-test-secret") {
    const response = await fetch(base + path, { method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify({ update_id: id }) });
    await response.text();
    return response.status;
  }
  assert.equal(await send("/bot/telegram", 1), 200);
  assert.equal(await send("/telegram", 2), 200);
  assert.equal(await send("/bot/telegram", 3, "incorrect"), 401);
  assert.equal(await send("/other/telegram", 4), 404);
  assert.deepEqual(seen, [1, 2]);
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
