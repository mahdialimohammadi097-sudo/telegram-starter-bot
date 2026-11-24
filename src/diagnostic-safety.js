export function safeDiagnosticCode(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  return /^[0-9A-Z]{5}$/.test(code) ? code : "UNAVAILABLE";
}

// Telegram API codes are HTTP-style integers, never arbitrary response text or objects.
export function safeTelegramDiagnosticCode(error, fallback = "UNAVAILABLE") {
  const code = error?.error_code;
  return Number.isInteger(code) && code >= 400 && code <= 599 ? code : fallback;
}
