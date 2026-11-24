// Telegram secret_token permits A-Z, a-z, 0-9, underscore and hyphen (1..256).
// Fail closed; never log or return the secret in an error.
export function requireWebhookSecret(value) {
 if(typeof value!=="string")throw new Error("Invalid WEBHOOK_SECRET configuration");
 const secret=value.trim();
 if(!/^[A-Za-z0-9_-]{1,256}$/.test(secret))
  throw new Error("Invalid WEBHOOK_SECRET configuration");
 return secret;
}
