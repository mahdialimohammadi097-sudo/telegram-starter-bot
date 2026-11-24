import { auditDepositSchema } from "./deposit-schema-audit.js";
import { rollbackTransaction } from "./transaction-safety.js";

// Operator-only. All inspection uses one bounded read-only snapshot.
export async function runReadOnlyDepositAudit(pool, inspect = auditDepositSchema) {
  const client = await pool.connect();
  let discard;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    const result = await inspect(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    discard = await rollbackTransaction(client, error);
    throw error;
  } finally {
    client.release(discard || undefined);
  }
}
