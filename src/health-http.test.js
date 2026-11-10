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
