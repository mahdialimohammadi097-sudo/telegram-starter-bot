import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isPrivateSimulationChat } from "./simulation-chat-safety.js";

test("all simulation financial entry points reject non-private chats before any write", () => {
  const source = readFileSync(new URL("./commands.js", import.meta.url), "utf8");
  const starts = [
    'bot.callbackQuery(/^sim_open:',
    'bot.command("testwithdraw"',
    'bot.callbackQuery(/^sim_hold:',
    'bot.callbackQuery(/^sim_cancel_hold:'
  ];
  for (const start of starts) {
    const index = source.indexOf(start);
    assert.notEqual(index, -1, "missing handler " + start);
    const next = source.slice(index, index + 450);
    assert.match(next, /!isPrivateSimulationChat\(ctx\)/, start);
  }
});

test("private-chat guard accepts only a matching authenticated sender", () => {
  assert.equal(isPrivateSimulationChat({ from: { id: 123 }, chat: { id: 123, type: "private" } }), true);
  for (const ctx of [
    null,
    {},
    { from: { id: 123 }, chat: { id: -100, type: "supergroup" } },
    { from: { id: 123 }, chat: { id: 123, type: "group" } },
    { from: { id: 123 }, chat: { id: 456, type: "private" } },
    { from: { id: 0 }, chat: { id: 0, type: "private" } },
    { from: { id: "123" }, chat: { id: "123", type: "private" } },
    { from: { id: 123 } }
  ]) {
    assert.equal(isPrivateSimulationChat(ctx), false);
  }
});
