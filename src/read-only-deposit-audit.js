import { auditDepositSchema } from "./deposit-schema-audit.js";
import { rollbackTransaction } from "./transaction-safety.js";

// Operator-only. All inspection uses one bounded read-only snapshot.
export async function runReadOnlyDepositAudit(pool, inspect = auditDepositSchema) {
  const client = await pool.connect();
  let discard;
  let transactionOpen = false;
  try {
    const started = await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    if (started?.command !== "BEGIN") throw new Error("Read-only audit transaction start unconfirmed");
    transactionOpen = true;
    const statementLimit = await client.query("SET LOCAL statement_timeout = '10s'");
    const lockLimit = await client.query("SET LOCAL lock_timeout = '3s'");
    if (statementLimit?.command !== "SET" || lockLimit?.command !== "SET") {
      throw new Error("Read-only audit time limits unconfirmed");
    }
    const state = await client.query(`SELECT pg_catalog.current_setting('transaction_read_only') AS read_only,
      pg_catalog.current_setting('transaction_isolation') AS isolation,
      pg_catalog.current_setting('statement_timeout') AS statement_timeout,
      pg_catalog.current_setting('lock_timeout') AS lock_timeout`);
    const settings = state.rows?.[0];
    if (state.rows?.length !== 1 || settings?.read_only !== "on" ||
        settings.isolation !== "repeatable read" || settings.statement_timeout !== "10s" ||
        settings.lock_timeout !== "3s") {
      throw new Error("Read-only audit transaction settings incompatible");
    }
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
