import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
    assert.match(next, /ctx\.chat\?\.type !== "private" \|\| ctx\.chat\.id !== ctx\.from\.id/, start);
  }
});
