export async function rollbackTransaction(client, originalError) {
  try {
    const result = await client.query("ROLLBACK");
    if (result?.command !== "ROLLBACK") {
      throw new Error("PostgreSQL rollback unconfirmed");
    }
    return null;
  } catch (rollbackError) {
    if (originalError && typeof originalError === "object") {
      // Diagnostic attachment is best-effort; frozen errors must not prevent discard.
      try { originalError.rollbackError = rollbackError; } catch {}
    }
    // Pass this error to pg Client.release(error) so an uncertain connection
    // is destroyed instead of being returned to the pool.
    return rollbackError instanceof Error ? rollbackError : new Error("PostgreSQL rollback failed");
  }
}
