import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("runtime injects guarded simulation handlers only after authenticated bot identity", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const identity = source.indexOf("bot.api.getMe()");
  const guarded = source.indexOf("createStagingSimulationHandlers(pool, process.env, me.username)");
  const wired = source.indexOf("registerCommands(bot, simulationHandlers)");
  assert.ok(identity >= 0, "runtime must authenticate Telegram identity");
  assert.ok(guarded > identity, "staging isolation must be verified after authentication");
  assert.ok(wired > guarded, "commands must receive only verified staging handlers");
  assert.equal(source.includes("registerCommands(bot);"), false, "unwired runtime is not a functional staging journey");
});
