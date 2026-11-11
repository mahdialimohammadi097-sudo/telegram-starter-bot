import { assertBalancedLedgerEntries, toUsdtUnitsExact } from "./ledger-safety.js";

function normalizeAccountId(value) {
  const id = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new TypeError("Invalid ledger account id");
  }
  return id;
}

function decimalFromUnits(units) {
  const whole = units / 100000000n;
  const fraction = String(units % 100000000n).padStart(8, "0");
  return whole.toString() + "." + fraction;
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new Error("A ledger transaction requires at least two entries");
  }

  const normalized = entries.map((entry) => {
    const currency = String(entry.currency ?? "").trim().toUpperCase();
    const entryType = String(entry.entry_type ?? "").trim().toLowerCase();
    const accountId = normalizeAccountId(entry.account_id);
    const units = toUsdtUnitsExact(entry.amount);

    if (currency !== "USDT") {
      throw new Error("Only USDT ledger posting is supported");
    }
    if (!["debit", "credit"].includes(entryType) || units <= 0n) {
      throw new Error("Invalid ledger entry");
    }

    return {
      account_id: accountId,
      entry_type: entryType,
      amount: decimalFromUnits(units),
      currency,
      units
    };
  });

  assertBalancedLedgerEntries(normalized);
  return normalized;
}

function canonicalEntries(entries) {
  return entries
    .map((entry) => ({
      account_id: normalizeAccountId(entry.account_id),
      entry_type: String(entry.entry_type).toLowerCase(),
      currency: String(entry.currency).toUpperCase(),
      units: toUsdtUnitsExact(entry.amount).toString()
    }))
    .sort((a, b) =>
      a.account_id.localeCompare(b.account_id) ||
      a.entry_type.localeCompare(b.entry_type) ||
      a.currency.localeCompare(b.currency) ||
      a.units.localeCompare(b.units)
    );
}

function sameEntries(left, right) {
  return JSON.stringify(canonicalEntries(left)) ===
    JSON.stringify(canonicalEntries(right));
}

/**
 * Atomically posts a balanced USDT journal.
 *
 * This service is intentionally not wired to customer actions. The caller must
 * authorize account ownership and supply a stable idempotency key. Production
 * use remains blocked until the live trigger definitions and PostgreSQL
 * concurrency behavior have been independently verified.
 */
export async function postLedgerTransaction({
  pool,
  transactionType,
  referenceId = null,
  idempotencyKey,
  description = null,
  entries
}) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("A PostgreSQL pool is required");
  }

  const type = String(transactionType ?? "").trim();
  const key = String(idempotencyKey ?? "").trim();
  const normalizedReferenceId = referenceId == null ? null : String(referenceId);
  const normalizedDescription = description == null ? null : String(description);
  if (!type || type.length > 100) throw new TypeError("Invalid transaction type");
  if (!key || key.length > 200) throw new TypeError("Invalid idempotency key");

  const normalizedEntries = normalizeEntries(entries);
  const accountIds = [...new Set(normalizedEntries.map((entry) => entry.account_id))]
    .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    // Serialize retries with the same key, including requests racing on separate
    // application instances. PostgreSQL releases this lock at transaction end.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [key]
    );

    const existing = await client.query(
      `SELECT id, transaction_type, reference_id, description, status
       FROM ledger_transactions
       WHERE idempotency_key = $1
       FOR UPDATE`,
      [key]
    );

    if (existing.rowCount) {
      const transaction = existing.rows[0];
      const priorEntries = await client.query(
        `SELECT account_id, entry_type, amount::text AS amount, currency
         FROM ledger_entries
         WHERE transaction_id = $1
         ORDER BY account_id, entry_type, amount, currency`,
        [transaction.id]
      );

      const sameMetadata =
        transaction.transaction_type === type &&
        (transaction.reference_id ?? null) === normalizedReferenceId &&
        (transaction.description ?? null) === normalizedDescription;

      if (!sameMetadata || !sameEntries(priorEntries.rows, normalizedEntries)) {
        throw new Error("Idempotency key was already used for a different request");
      }
      if (transaction.status !== "posted") {
        throw new Error("Existing idempotent transaction is not posted");
      }

      await client.query("COMMIT");
      transactionOpen = false;
      return { transactionId: String(transaction.id), posted: true, idempotent: true };
    }

    const accountResult = await client.query(
      `SELECT id, account_type, currency
       FROM ledger_accounts
       WHERE id = ANY($1::bigint[])
       ORDER BY id
       FOR UPDATE`,
      [accountIds]
    );

    if (accountResult.rowCount !== accountIds.length) {
      throw new Error("One or more ledger accounts do not exist");
    }

    const accounts = new Map(
      accountResult.rows.map((account) => [String(account.id), account])
    );

    for (const entry of normalizedEntries) {
      const account = accounts.get(entry.account_id);
      if (!account || String(account.currency).toUpperCase() !== entry.currency) {
        throw new Error("Ledger account currency does not match the entry");
      }
    }

    const byAccount = new Map();
    for (const entry of normalizedEntries) {
      const current = byAccount.get(entry.account_id) ?? { debit: 0n, credit: 0n };
      current[entry.entry_type] += entry.units;
      byAccount.set(entry.account_id, current);
    }

    for (const [accountId, movement] of byAccount) {
      const account = accounts.get(accountId);
      if (String(account.account_type).toUpperCase() !== "AVAILABLE") continue;

      const balanceResult = await client.query(
        `SELECT COALESCE(
                  SUM(CASE WHEN le.entry_type = 'credit'
                           THEN le.amount ELSE -le.amount END),
                  0
                )::text AS balance
         FROM ledger_entries le
         JOIN ledger_transactions lt ON lt.id = le.transaction_id
         WHERE le.account_id = $1
           AND le.currency = 'USDT'
           AND lt.status = 'posted'`,
        [accountId]
      );
      const currentBalance = toUsdtUnitsExact(balanceResult.rows[0].balance);
      if (currentBalance + movement.credit - movement.debit < 0n) {
        throw new Error("Insufficient available balance");
      }
    }

    const inserted = await client.query(
      `INSERT INTO ledger_transactions
         (transaction_type, reference_id, idempotency_key, description, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id`,
      [type, normalizedReferenceId, key, normalizedDescription]
    );
    const transactionId = inserted.rows[0]?.id;
    if (transactionId === undefined || transactionId === null) {
      throw new Error("Ledger transaction insert returned no id");
    }

    for (const entry of normalizedEntries) {
      await client.query(
        `INSERT INTO ledger_entries
           (transaction_id, account_id, entry_type, amount, currency)
         VALUES ($1, $2, $3, $4, $5)`,
        [transactionId, entry.account_id, entry.entry_type, entry.amount, entry.currency]
      );
    }

    const posted = await client.query(
      `UPDATE ledger_transactions
       SET status = 'posted'
       WHERE id = $1 AND status = 'pending'`,
      [transactionId]
    );
    if (posted.rowCount !== 1) {
      throw new Error("Ledger transaction could not transition from pending to posted");
    }

    await client.query("COMMIT");
    transactionOpen = false;
    return { transactionId: String(transactionId), posted: true, idempotent: false };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
        // A client with an uncertain transaction state must not return to the pool.
        releaseError = rollbackError;
      }
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export { normalizeEntries, canonicalEntries };
