import { runReadOnlyDepositAudit } from "./read-only-deposit-audit.js";

const findingKeys = [
  "unresolved_journals", "missing_idempotency_keys", "duplicate_idempotency_keys",
  "invalid_entries", "invalid_account_currencies", "noncanonical_idempotency_keys",
  "invalid_row_identity_groups",
  "unbalanced_posted_journals", "negative_customer_accounts", "negative_noncustomer_protected_accounts"
];
const countKeys = ["journals", "posted_journals", "entries", ...findingKeys];

// Offline/operator-only integrity snapshot. Never repair balances or infer
// custody, business authorization, or production readiness from a clean scan.
// Explicit schema qualification prevents accidentally inspecting shadow tables.
export async function auditLedgerIntegrity(pool, { schema = "public" } = {}) {
  if (typeof schema !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new TypeError("Invalid ledger audit schema");
  }
  return runReadOnlyDepositAudit(pool, client => inspectLedgerIntegrity(client,{schema}));
}

// Internal inspection; caller must hold a verified read-only snapshot.
export async function inspectLedgerIntegrity(client,{schema="public"}={}) {
  if(typeof schema!=="string"||!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new TypeError("Invalid ledger audit schema");
  const s = '"' + schema + '"';
    // row_security=off fails instead of silently omitting RLS-filtered rows.
    const security = await client.query("SET LOCAL row_security = off");
    const searchPath = await client.query("SET LOCAL search_path = pg_catalog");
    if (security?.command !== "SET" || searchPath?.command !== "SET") {
      throw new Error("Ledger audit settings unconfirmed");
    }
    const state = await client.query(`SELECT current_setting('row_security') AS row_security,
      current_setting('search_path') AS search_path`);
    if (state.rows?.length !== 1 || state.rows[0].row_security !== "off" ||
        state.rows[0].search_path !== "pg_catalog") {
      throw new Error("Ledger audit settings incompatible");
    }
    // A standalone scan must not report a clean ledger when a view hides
    // rows or table inheritance silently expands the audited relations.
    const shape = await client.query(`
      SELECT count(*)::int AS relation_count,
        COALESCE(bool_and(c.relkind='r' AND c.relpersistence='p'
          AND NOT c.relispartition
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i
            WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite rw
            WHERE rw.ev_class=c.oid)),false) AS relation_shape_compatible,
        COALESCE(bool_and(NOT c.relrowsecurity AND NOT c.relforcerowsecurity
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
            WHERE p.polrelid=c.oid)),false) AS row_visibility_compatible
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1
        AND c.relname IN ('ledger_accounts','ledger_transactions','ledger_entries')
    `,[schema]);
    if(shape.rows?.length!==1 || shape.rows[0].relation_count!==3 ||
       shape.rows[0].relation_shape_compatible!==true){
      throw new Error("Ledger integrity requires three permanent ordinary relations without inheritance or rewrite rules");
    }
    // Even an audit role that bypasses RLS cannot certify the historical
    // ledger contract when the runtime role may see a different row set.
    // Reject dormant policies too; never output policy names or definitions.
    if(shape.rows[0].row_visibility_compatible!==true){
      throw new Error("Ledger integrity requires reviewed row visibility without RLS or policies");
    }
    const { rows } = await client.query(`
      WITH journals AS (
        SELECT id, status, idempotency_key FROM ${s}.ledger_transactions
      ), accounts AS (
        SELECT id, user_id, account_type, currency FROM ${s}.ledger_accounts
      ), entries AS (
        SELECT e.*, t.status AS journal_status, t.id AS journal_exists,
               a.id AS account_exists, a.currency AS account_currency
        FROM ${s}.ledger_entries e
        LEFT JOIN journals t ON t.id=e.transaction_id
        LEFT JOIN accounts a ON a.id=e.account_id
      ), invalid_identities AS (
        SELECT id FROM journals GROUP BY id HAVING id IS NULL OR count(*)>1
        UNION ALL
        SELECT id FROM accounts GROUP BY id HAVING id IS NULL OR count(*)>1
        UNION ALL
        SELECT id FROM ${s}.ledger_entries GROUP BY id HAVING id IS NULL OR count(*)>1
      ), currency_totals AS (
        SELECT transaction_id, currency, count(*) AS lines,
          sum(amount) FILTER (WHERE entry_type='debit') AS debits,
          sum(amount) FILTER (WHERE entry_type='credit') AS credits
        FROM entries WHERE journal_status='posted' GROUP BY transaction_id, currency
      ), bad_journals AS (
        SELECT j.id FROM journals j WHERE j.status='posted' AND (
          NOT EXISTS (SELECT 1 FROM currency_totals c WHERE c.transaction_id=j.id)
          OR EXISTS (SELECT 1 FROM currency_totals c WHERE c.transaction_id=j.id
            AND (c.lines<2 OR c.debits IS NULL OR c.credits IS NULL OR c.debits<>c.credits))
        )
      ), protected_balances AS (
        SELECT a.id, a.user_id, sum(CASE WHEN e.entry_type='credit' THEN e.amount
                          WHEN e.entry_type='debit' THEN -e.amount ELSE 0 END) AS balance
        FROM accounts a JOIN entries e ON e.account_id=a.id
        WHERE upper(a.account_type) IN ('AVAILABLE','INVESTED','WITHDRAWAL_HOLD')
          AND a.currency='USDT' AND e.currency='USDT' AND e.journal_status='posted'
        GROUP BY a.id,a.user_id
      )
      SELECT
        (SELECT count(*) FROM journals)::text AS journals,
        (SELECT count(*) FROM journals WHERE status='posted')::text AS posted_journals,
        (SELECT count(*) FROM entries)::text AS entries,
        (SELECT count(*) FROM journals WHERE status IS DISTINCT FROM 'posted')::text AS unresolved_journals,
        (SELECT count(*) FROM journals WHERE idempotency_key IS NULL OR idempotency_key !~ '[^[:space:]]')::text AS missing_idempotency_keys,
        (SELECT count(*) FROM (SELECT idempotency_key FROM journals
           WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key HAVING count(*)>1) d)::text AS duplicate_idempotency_keys,
        (SELECT count(*) FROM entries WHERE journal_exists IS NULL OR account_exists IS NULL
          OR currency IS DISTINCT FROM 'USDT' OR account_currency IS DISTINCT FROM currency
          OR entry_type IS NULL OR entry_type NOT IN ('debit','credit')
          OR amount IS NULL OR amount::text IN ('NaN','Infinity','-Infinity')
          OR amount<=0 OR amount<>trunc(amount,8))::text AS invalid_entries,
        (SELECT count(*) FROM accounts WHERE currency IS DISTINCT FROM 'USDT')::text AS invalid_account_currencies,
        (SELECT count(*) FROM journals WHERE idempotency_key ~ '[^[:space:]]'
          AND idempotency_key ~ '^[[:space:]]|[[:space:]]$')::text AS noncanonical_idempotency_keys,
        (SELECT count(*) FROM invalid_identities)::text AS invalid_row_identity_groups,
        (SELECT count(*) FROM bad_journals)::text AS unbalanced_posted_journals,
        (SELECT count(*) FROM protected_balances WHERE user_id IS NOT NULL AND balance<0)::text AS negative_customer_accounts,
        (SELECT count(*) FROM protected_balances WHERE user_id IS NULL AND balance<0)::text AS negative_noncustomer_protected_accounts
    `);
    if (rows?.length !== 1 || countKeys.some(k => typeof rows[0][k] !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(rows[0][k])) ||
        BigInt(rows[0].posted_journals) > BigInt(rows[0].journals) ||
        BigInt(rows[0].unresolved_journals) + BigInt(rows[0].posted_journals) !== BigInt(rows[0].journals)) {
      throw new Error("Incomplete ledger integrity audit");
    }
    const counts = Object.fromEntries(countKeys.map(k => [k, rows[0][k]]));
    return { scope: "internal-ledger-integrity-only", counts,
      clean: findingKeys.every(k => counts[k] === "0"),
      custodyVerified: false, productionReady: false };
}
