import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {randomUUID} from "node:crypto";
import { createCatalogDepositOwnerResolver } from "./catalog-deposit-owner.js";
import { requireUniqueDepositOwner } from "./deposit-owner-guard.js";
const url = process.env.CATALOG_REHEARSAL_URL;
test("catalog locks prevent concurrent assignment writes", {skip: !isDisposablePostgresTarget(url, "catalog_rehearsal")}, async () => {
  const parsed = new URL(url);
  assert.ok(["localhost","127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname,"/catalog_rehearsal");
  const pool = new pg.Pool({connectionString:url});
  const role = "catalog_visibility_"+randomUUID().replaceAll("-","");
  let roleCreated=false;
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
    // User status changes must not race with an in-flight attribution.
    await b.query("BEGIN");
    await b.query("SET LOCAL lock_timeout = '300ms'");
    await assert.rejects(
      b.query("UPDATE public.users SET status = 'blocked' WHERE id = 1"),
      {code:"55P03"}
    );
    await b.query("ROLLBACK");
    await a.query("COMMIT");
    // After commit, the second transaction can resolve the same owner.
    await b.query("BEGIN");
    assert.equal(requireUniqueDepositOwner(evidence,await resolve(b,evidence)).userId,"1");
    await b.query("ROLLBACK");
    // A previously committed or rolled-back transaction must not leave a
    // reusable authorization marker on this pooled database connection.
    await assert.rejects(resolve(b,evidence), /Explicit database transaction required/);
    await b.query("INSERT INTO public.user_wallet_assignments VALUES (2,2,1,'active',NULL,'deposit')");
    await a.query("BEGIN");
    assert.throws(() => requireUniqueDepositOwner(evidence, []));
    const rows = await resolve(a,evidence);
    assert.equal(rows.length,2);
    assert.throws(() => requireUniqueDepositOwner(evidence,rows));
    await a.query("ROLLBACK");
    // Historical assignments must fail closed even when no longer active.
    await a.query("UPDATE public.user_wallet_assignments SET status = 'inactive' WHERE id = 2");
    await a.query("BEGIN");
    const historicalRows = await resolve(a,evidence);
    assert.equal(historicalRows.length, 2);
    assert.throws(() => requireUniqueDepositOwner(evidence, historicalRows));
    await a.query("ROLLBACK");
    // A dangling historical assignment must remain visible, never disappear
    // through an INNER JOIN and allow a false unique-owner attribution.
    await a.query("UPDATE public.user_wallet_assignments SET user_id = 999 WHERE id = 2");
    await a.query("BEGIN");
    const orphanedRows = await resolve(a,evidence);
    assert.equal(orphanedRows.length,2);
    assert.equal(orphanedRows.find(row => row.userId === "999")?.active,false);
    assert.throws(() => requireUniqueDepositOwner(evidence,orphanedRows));
    await a.query("ROLLBACK");
    // Remove the duplicate so each subsequent rejection tests its own cause.
    await a.query("DELETE FROM public.user_wallet_assignments WHERE id = 2");
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
    // A restricted role sees only one assignment without the resolver's RLS guard.
    await a.query("UPDATE public.wallets SET network='BEP20' WHERE id=1");
    await a.query("INSERT INTO public.user_wallet_assignments VALUES (2,2,1,'active',NULL,'deposit')");
    await a.query('CREATE ROLE "'+role+'" NOLOGIN NOSUPERUSER NOBYPASSRLS');roleCreated=true;
    await a.query('GRANT USAGE ON SCHEMA public TO "'+role+'"');
    await a.query('GRANT SELECT, UPDATE ON public.users, public.wallets, public.user_wallet_assignments TO "'+role+'"');
    await a.query("ALTER TABLE public.user_wallet_assignments ENABLE ROW LEVEL SECURITY");
    await a.query('CREATE POLICY rehearsal_visible_owner ON public.user_wallet_assignments FOR SELECT TO "'+role+'" USING (user_id=1)');
    await a.query('SET ROLE "'+role+'"');
    assert.equal((await a.query("SELECT count(*)::int AS n FROM public.user_wallet_assignments")).rows[0].n,1);
    await a.query("BEGIN");
    await assert.rejects(resolve(a,evidence),{code:"42501"});
    await a.query("ROLLBACK");
    assert.equal((await a.query("SELECT current_setting('row_security') AS setting")).rows[0].setting,"on");
    await a.query("RESET ROLE");
  } finally {
    await a.query("ROLLBACK").catch(()=>{});
    await b.query("ROLLBACK").catch(()=>{});
    try {
      await a.query("RESET ROLE");
      if(roleCreated){
        await a.query("DROP POLICY IF EXISTS rehearsal_visible_owner ON public.user_wallet_assignments");
        await a.query("ALTER TABLE public.user_wallet_assignments DISABLE ROW LEVEL SECURITY");
        await a.query('DROP OWNED BY "'+role+'"');
        await a.query('DROP ROLE "'+role+'"');
      }
    } finally {a.release(); b.release(); await pool.end();}
  }
});
