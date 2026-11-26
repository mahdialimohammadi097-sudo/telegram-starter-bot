import { webhookCallback } from "grammy";

function requireWebhookSecret(secret) {
  if (typeof secret !== "string" || secret.length < 1 || secret.length > 256 || /[^A-Za-z0-9_-]/.test(secret)) {
    throw new Error("Invalid WEBHOOK_SECRET");
  }
  return secret;
}

export function webhookConfiguration(base, secret) {
  requireWebhookSecret(secret);
  if (typeof base !== "string" || base.includes("?") || base.includes("#")) {
    throw new Error("Invalid WEBHOOK_URL");
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
  return Object.freeze({ url: url.href, secret });
}

export function telegramWebhookHandler(bot, configuration) {
  // Validate at the handler boundary as well as at startup. An independently
  // constructed configuration must never silently disable authentication.
  const secretToken = requireWebhookSecret(configuration?.secret);
  return webhookCallback(bot, "http", { secretToken });
}
