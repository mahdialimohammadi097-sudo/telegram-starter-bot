import test from "node:test";
import assert from "node:assert/strict";
import { editAdminMessageSafely } from "./admin-message-edit.js";

test("ignores only Telegram 400 message is not modified", async () => {
  const ctx = { editMessageText: async () => {
    throw { error_code: 400, description: "Bad Request: message is not modified" };
  } };
  assert.equal(await editAdminMessageSafely(ctx, "same", {}), undefined);
});

test("propagates other Telegram 400 errors", async () => {
  const failure = { error_code: 400, description: "Bad Request: message to edit not found" };
  const ctx = { editMessageText: async () => { throw failure; } };
  await assert.rejects(editAdminMessageSafely(ctx, "text", {}), error => error === failure);
});

test("propagates unchanged-message text with non-400 status", async () => {
  const failure = { error_code: 500, description: "message is not modified" };
  const ctx = { editMessageText: async () => { throw failure; } };
  await assert.rejects(editAdminMessageSafely(ctx, "text", {}), error => error === failure);
});

test("returns successful edit result", async () => {
  const result = { message_id: 123 };
  const ctx = { editMessageText: async (message, options) => {
    assert.equal(message, "updated");
    assert.deepEqual(options, { reply_markup: "keyboard" });
    return result;
  } };
  assert.equal(await editAdminMessageSafely(ctx, "updated", { reply_markup: "keyboard" }), result);
});
