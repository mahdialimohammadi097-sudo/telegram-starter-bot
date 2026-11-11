export async function rollbackTransaction(client, originalError) {
  try {
    await client.query("ROLLBACK");
    return null;
  } catch (rollbackError) {
    if (originalError && typeof originalError === "object") {
      originalError.rollbackError = rollbackError;
    }
    // Pass this error to pg Client.release(error) so an uncertain connection
    // is destroyed instead of being returned to the pool.
    return rollbackError;
  }
}
