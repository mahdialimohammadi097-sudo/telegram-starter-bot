import { auditDepositSchema } from "./deposit-schema-audit.js";
import { rollbackTransaction } from "./transaction-safety.js";

// Operator-only. All inspection uses one bounded read-only snapshot.
export async function runReadOnlyDepositAudit(pool, inspect = auditDepositSchema) {
  const client = await pool.connect();
  let discard;
  let transactionOpen = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    const result = await inspect(client);
    const completion = await client.query("COMMIT");
    transactionOpen = false;
    if (completion?.command !== "COMMIT") {
      throw new Error("Read-only audit transaction did not commit");
    }
    return result;
  } catch (error) {
    discard = transactionOpen
      ? await rollbackTransaction(client, error)
      : error instanceof Error ? error : new Error("Read-only audit transaction failed");
    throw error;
  } finally {
    client.release(discard || undefined);
  }
}
