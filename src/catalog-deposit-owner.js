// Experimental adapter for disposable database rehearsal only.
// Not wired to Telegram or production. Caller must own a transaction.
// Table locks deliberately serialize assignment writers, including inserts.
// Historical address reassignment outside this catalog remains a release gate.
export function createCatalogDepositOwnerResolver({ tokenContract } = {}) {
  const addressPattern = /^0x[0-9a-fA-F]{40}$/;
  if (typeof tokenContract !== "string" || !addressPattern.test(tokenContract) || /^0x0{40}$/i.test(tokenContract)) {
    throw new TypeError("Trusted USDT contract configuration required");
  }
  const contract = tokenContract.toLowerCase();
  return async function resolveAndLockAssignments(client, evidence) {
    if (evidence?.chainId !== "56" ||
        typeof evidence.depositAddress !== "string" ||
        !addressPattern.test(evidence.depositAddress) || /^0x0{40}$/i.test(evidence.depositAddress) ||
        typeof evidence.tokenContract !== "string" ||
        evidence.tokenContract.toLowerCase() !== contract) {
      throw new Error("Unexpected deposit chain or token");
    }
    // SET LOCAL is discarded after a standalone statement; a follow-up read
    // must see the marker only when the caller owns an explicit transaction.
    const started = await client.query("SET LOCAL profino.deposit_owner_tx = 'active'");
    const boundary = await client.query("SELECT current_setting('profino.deposit_owner_tx', true) AS marker");
    if (started?.command !== 'SET' || boundary.rows?.length !== 1 || boundary.rows[0].marker !== 'active') {
      throw new Error("Explicit database transaction required for deposit ownership");
    }
    const limit = await client.query("SET LOCAL lock_timeout = '2s'");
    const visibility = await client.query("SET LOCAL row_security = off");
    const settings = await client.query("SELECT pg_catalog.current_setting('row_security') AS row_security, pg_catalog.current_setting('lock_timeout') AS lock_timeout");
    // PostgreSQL raises an error if RLS would filter the lookup. Never bypass it.
    if (limit?.command !== "SET" || visibility?.command !== "SET" ||
        settings.rows?.length !== 1 || settings.rows[0].row_security !== "off" ||
        settings.rows[0].lock_timeout !== "2s") {
      throw new Error("Deposit ownership visibility or lock limit unconfirmed");
    }
    const locked = await client.query("LOCK TABLE public.users, public.wallets, public.user_wallet_assignments IN SHARE ROW EXCLUSIVE MODE");
    if (locked?.command !== "LOCK") throw new Error("Deposit ownership lock unconfirmed");
    const result = await client.query(
      `SELECT a.user_id::text AS user_id, w.wallet_address,
              (a.status = 'active' AND a.ended_at IS NULL
               AND a.assignment_type = 'deposit'
               AND w.status = 'active' AND w.network = 'BEP20'
               AND w.wallet_type = 'deposit' AND w.is_platform_controlled
               AND u.status = 'active') AS active
         FROM public.wallets w
         JOIN public.user_wallet_assignments a ON a.wallet_id = w.id
         LEFT JOIN public.users u ON u.id = a.user_id
        WHERE w.chain_id = 56 AND lower(w.wallet_address) = $1
        ORDER BY a.id`, [evidence.depositAddress.toLowerCase()]);
    // Preserve orphaned assignment rows as inactive: an INNER JOIN would hide\n    // them and could incorrectly make a conflicting owner look unique.\n    // No attribution is safe if the catalog has no historical assignment
    // evidence; the caller must fail closed on empty or ambiguous results.
    if (!Array.isArray(result?.rows) || result.rowCount !== result.rows.length) {
      throw new Error("Incomplete deposit ownership result");
    }
    return result.rows.map(row => ({
      userId: row.user_id, address: row.wallet_address,
      active: row.active === true, chainId: 56,
      currency: "USDT", tokenContract: contract
    }));
  };
}
