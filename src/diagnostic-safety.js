export function safeDiagnosticCode(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  return /^[0-9A-Z]{5}$/.test(code) ? code : "UNAVAILABLE";
}
