export function formatStartupHealthReport({
  botUsername,
  mode,
  nodeVersion,
  databaseConnected,
  schemaSnapshot = null,
  schemaError = null,
  checkedAt = new Date()
}) {
  const lines = [
    "PROFINO — STARTUP HEALTH REPORT",
    "Time: " + checkedAt.toISOString(),
    "Telegram bot: " + (botUsername ? "CONNECTED (@" + botUsername + ")" : "NOT VERIFIED"),
    "Runtime: " + (mode || "unknown") + " | Node " + (nodeVersion || "unknown"),
    "PostgreSQL: " + (databaseConnected ? "CONNECTED" : "NOT VERIFIED")
  ];

  if (schemaSnapshot) {
    const expected = schemaSnapshot.expectedTables || [];
    const existing = new Set(schemaSnapshot.existingTables || []);
    const missing = expected.filter(name => !existing.has(name));
    lines.push(
      "Database schema: " + (missing.length === 0 ? "CORE TABLES PRESENT" : "ATTENTION REQUIRED"),
      "Tables: " + existing.size + "/" + expected.length + " expected core tables found",
      "Inventory: " + (schemaSnapshot.tableInventory || []).length + " total tables",
      "Indexes: " + (schemaSnapshot.indexes || []).length,
      "User-defined triggers: " + (schemaSnapshot.triggers || []).length
    );
    if (missing.length) lines.push("Missing core tables: " + missing.join(", "));
  } else {
    lines.push("Database schema inspection: FAILED");
    if (schemaError) lines.push("Diagnostic code: " + String(schemaError).slice(0, 80));
  }

  lines.push(
    "",
    "Read-only checks only. No balances, transactions, users, or schema were changed."
  );

  return lines.join("\n");
}
