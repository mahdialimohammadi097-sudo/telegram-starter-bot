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
