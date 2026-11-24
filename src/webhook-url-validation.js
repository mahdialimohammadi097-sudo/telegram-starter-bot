// Validate public Telegram webhook destination before opening any runtime service.
// Do not echo user-provided URL or credentials into errors.
export function requireWebhookUrl(value) {
 if(typeof value!=="string")throw new Error("Invalid WEBHOOK_URL configuration");
 const normalized=value.trim().replace(/\/$/,"");
 let parsed;
 try { parsed=new URL(normalized); } catch { throw new Error("Invalid WEBHOOK_URL configuration"); }
 if(parsed.protocol!=="https:" || !parsed.hostname ||
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    parsed.port && parsed.port!=="443" ||
    parsed.hostname==="localhost" || parsed.hostname.endsWith(".localhost") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) ||
    parsed.hostname.includes(":") ||
    !parsed.hostname.includes("."))
  throw new Error("Invalid WEBHOOK_URL configuration");
 return normalized;
}
