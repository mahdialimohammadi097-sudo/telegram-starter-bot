import test from "node:test";
import assert from "node:assert/strict";
import {requireWebhookSecret} from "./webhook-secret-validation.js";

test("webhook mode requires valid Telegram secret token",()=>{
 for(const bad of [undefined,null,"","  ","a b","x/y","abc\nxyz","!bad","x".repeat(257),123]){
  assert.throws(()=>requireWebhookSecret(bad),/Invalid WEBHOOK_SECRET configuration/);
 }
});
test("accepts Telegram permitted secret tokens and trims configuration whitespace",()=>{
 assert.equal(requireWebhookSecret("abc_123-XYZ"),"abc_123-XYZ");
 assert.equal(requireWebhookSecret(" abc_123-XYZ "),"abc_123-XYZ");
 assert.equal(requireWebhookSecret("x".repeat(256)),"x".repeat(256));
});
test("error messages never disclose the configured secret",()=>{
 const value="secret-token-with-invalid-char!";
 assert.throws(()=>requireWebhookSecret(value),error=>
  !error.message.includes(value) && error.message.includes("WEBHOOK_SECRET"));
});
