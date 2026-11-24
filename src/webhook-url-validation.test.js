import test from "node:test";
import assert from "node:assert/strict";
import {requireWebhookUrl} from "./webhook-url-validation.js";

test("rejects malformed or nonpublic webhook destinations",()=>{
 for(const value of [undefined,"","http://example.com","https://localhost","https://127.0.0.1",
  "https://[::1]","https://example.com:8443","https://user:pass@example.com",
  "https://example.com/?token=secret","https://example.com/#secret",
  "https://example.com.evil.invalid@localhost"]){
  assert.throws(()=>requireWebhookUrl(value),/Invalid WEBHOOK_URL configuration/);
 }
});
test("accepts public HTTPS host and trims a trailing slash",()=>{
 assert.equal(requireWebhookUrl(" https://bot.example.com/ "),"https://bot.example.com");
 assert.equal(requireWebhookUrl("https://bot.example.com/path"),"https://bot.example.com/path");
});
test("does not expose invalid webhook URLs in error messages",()=>{
 const secret="https://secret:password@example.com";
 assert.throws(()=>requireWebhookUrl(secret),e=>!e.message.includes(secret));
});
