import { webhookCallback } from "grammy";

export function webhookConfiguration(base, secret) {
  if (typeof secret !== "string" || secret.length < 1 || secret.length > 256 || /[^A-Za-z0-9_-]/.test(secret)) {
    throw new Error("Invalid WEBHOOK_SECRET");
  }
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Invalid WEBHOOK_URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid WEBHOOK_URL");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") + "/telegram";
  return { url: url.href, secret };
}

export function telegramWebhookHandler(bot, configuration) {
  return webhookCallback(bot, "http", { secretToken: configuration.secret });
}
