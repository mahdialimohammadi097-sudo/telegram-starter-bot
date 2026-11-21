import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createCatalogDepositOwnerResolver } from "./catalog-deposit-owner.js";
import { requireUniqueDepositOwner } from "./deposit-owner-guard.js";
const url = process.env.CATALOG_REHEARSAL_URL;
test("catalog locks prevent concurrent assignment writes", {skip: !url}, async () => {
  const parsed = new URL(url);
  assert.ok(["localhost","127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname,"/catalog_rehearsal");
  const pool = new pg.Pool({connectionString:url});
  const a = await pool.connect();
  const b = await pool.connect();
  const address = "0x" + "b".repeat(40);
  const tokenContract = "0x" + "a".repeat(40);
  const evidence = {depositAddress:address, tokenContract, chainId:"56",
    eventKey:"bsc:56:0x"+"c".repeat(64)+":0",ledgerAmount:"10.00000000"};
  try {
    await a.query("CREATE TABLE public.users (id bigint PRIMARY KEY,status text)");
    await a.query("CREATE TABLE public.wallets (id bigint PRIMARY KEY,wallet_address text,status text,network text,wallet_type text,is_platform_controlled boolean,chain_id integer)");
    await a.query("CREATE TABLE public.user_wallet_assignments (id bigint PRIMARY KEY,user_id bigint,wallet_id bigint,status text,ended_at timestamptz,assignment_type text)");
    await a.query("INSERT INTO public.users VALUES (1,'active'),(2,'active')");
    await a.query("INSERT INTO public.wallets VALUES (1,$1,'active','BEP20','deposit',true,56)",[address]);
    await a.query("INSERT INTO public.user_wallet_assignments VALUES (1,1,1,'active',NULL,'deposit')");
    const resolve = createCatalogDepositOwnerResolver({tokenContract});
    // Standalone queries must not silently release the ownership lock.
    await assert.rejects(resolve(a,evidence), /Explicit database transaction required/);
    await a.query("BEGIN");
    assert.equal(requireUniqueDepositOwner(evidence,await resolve(a,evidence)).userId,"1");
    await b.query("BEGIN");
    await b.query("SET LOCAL lock_timeout = '300ms'");
    await assert.rejects(b.query("INSERT INTO public.user_wallet_assignments VALUES (2,2,1,'active',NULL,'deposit')"), {code:"55P03"});
    await b.query("ROLLBACK");
    // A second resolver must also fail rather than read while owner is locked.
    await b.query("BEGIN");
    await b.query("SET LOCAL lock_timeout = '300ms'");
    await assert.rejects(resolve(b,evidence), {code:"55P03"});
    await b.query("ROLLBACK");
    // Existing assignment reassignment is blocked as well as new inserts.
    await b.query("BEGIN");
    await b.query("SET LOCAL lock_timeout = '300ms'");
    await assert.rejects(
      b.query("UPDATE public.user_wallet_assignments SET user_id = 2 WHERE id = 1"),
      {code:"55P03"}
    );
    await b.query("ROLLBACK");
    // Wallet address reassignment is serialized by the same catalog lock.
    await b.query("BEGIN");
    await b.query("SET LOCAL lock_timeout = '300ms'");
    await assert.rejects(
      b.query("UPDATE public.wallets SET wallet_address = $1 WHERE id = 1", ["0x" + "d".repeat(40)]),
      {code:"55P03"}
    );
    await b.query("ROLLBACK");
    await a.query("COMMIT");
    // After commit, the second transaction can resolve the same owner.
    await b.query("BEGIN");
    assert.equal(requireUniqueDepositOwner(evidence,await resolve(b,evidence)).userId,"1");
    await b.query("ROLLBACK");
    await b.query("INSERT INTO public.user_wallet_assignments VALUES (2,2,1,'active',NULL,'deposit')");
    await a.query("BEGIN");
    assert.throws(() => requireUniqueDepositOwner(evidence, []));
    const rows = await resolve(a,evidence);
    assert.equal(rows.length,2);
    assert.throws(() => requireUniqueDepositOwner(evidence,rows));
    await a.query("ROLLBACK");
    // Even an inactive historical assignment must fail closed.
    await a.query("UPDATE public.user_wallet_assignments SET status = 'inactive' WHERE id = 2");
    await a.query("UPDATE public.users SET status = 'blocked' WHERE id = 1");
    await a.query("BEGIN");
    const blockedRows = await resolve(a,evidence);
    assert.throws(() => requireUniqueDepositOwner(evidence, blockedRows));
    await a.query("ROLLBACK");
    await a.query("UPDATE public.users SET status = 'active' WHERE id = 1");
    await a.query("UPDATE public.wallets SET status = 'suspended' WHERE id = 1");
    await a.query("BEGIN");
    const suspendedRows = await resolve(a,evidence);
    assert.throws(() => requireUniqueDepositOwner(evidence, suspendedRows));
    await a.query("ROLLBACK");
    // Wrong wallet purpose and network must not authorize a credit.
    await a.query("UPDATE public.wallets SET status = 'active', wallet_type = 'withdrawal' WHERE id = 1");
    await a.query("BEGIN");
    const wrongPurpose = await resolve(a,evidence);
    assert.throws(() => requireUniqueDepositOwner(evidence,wrongPurpose));
    await a.query("ROLLBACK");
    await a.query("UPDATE public.wallets SET wallet_type = 'deposit', network = 'OTHER' WHERE id = 1");
    await a.query("BEGIN");
    const wrongNetwork = await resolve(a,evidence);
    assert.throws(() => requireUniqueDepositOwner(evidence,wrongNetwork));
    await a.query("ROLLBACK");
  } finally {
    await a.query("ROLLBACK").catch(()=>{});
    await b.query("ROLLBACK").catch(()=>{});
    a.release(); b.release(); await pool.end();
  }
});
