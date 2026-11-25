import { Bot } from "grammy";
import { webhookConfiguration, telegramWebhookHandler } from "./telegram-webhook.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeHealthState } from "./runtime-health.js";
import { startHealthHttpServer } from "./health-http.js";

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

test("webhook handler lookup failures return a sanitized response and preserve liveness", async t => {
  let fail = true;
  const server = await startHealthHttpServer({ port: 0, runtimeHealth: createRuntimeHealthState(),
    getWebhookHandler() {
      if (fail) throw new Error("synthetic confidential detail");
      return (_req, res) => res.end("accepted");
    }
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const rejected = await fetch(base + "/telegram", { method: "POST" });
  assert.equal(rejected.status, 500);
  assert.equal(rejected.headers.get("cache-control"), "no-store");
  assert.equal(await rejected.text(), "webhook processing failed");
  assert.equal((await fetch(base + "/livez")).status, 200);
  fail = false;
  assert.equal(await (await fetch(base + "/telegram", { method: "POST" })).text(), "accepted");
});

test("direct webhook handler creation fails closed with invalid authentication configuration", () => {
  const bot = new Bot("offline", { botInfo: { id: 7, is_bot: true, first_name: "Fixture", username: "fixture_bot" } });
  for (const configuration of [undefined, null, {}, {secret: ""}, {secret: "bad secret"},
    {secret: "x".repeat(257)}, {secret: {toString: () => "fixture"}}]) {
    assert.throws(() => telegramWebhookHandler(bot, configuration), /Invalid WEBHOOK_SECRET/);
  }
  assert.equal(typeof telegramWebhookHandler(bot, {secret: "fixture"}), "function");
});

test("webhook configuration rejects ambiguous URL inputs and is immutable", () => {
  for (const base of ["https://example.invalid?", "https://example.invalid#", new URL("https://example.invalid")]) {
    assert.throws(() => webhookConfiguration(base, "fixture"), /Invalid WEBHOOK_URL/);
  }
  const config = webhookConfiguration("https://example.invalid", "fixture");
  assert.equal(Object.isFrozen(config), true);
  assert.throws(() => { config.secret = ""; }, TypeError);
  assert.equal(config.secret, "fixture");
});
