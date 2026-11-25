import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { createHash } from "node:crypto";
import { auditLedgerIntegrity } from "../src/ledger-integrity-audit.js";
import { reconcileSimulatedLiabilities } from "../test-support/reconcile-simulated-liabilities.js";
import { findSettlementDiscrepancies } from "../test-support/reconcile-simulated-settlements.js";
import { openSimulatedInvestment, settleSimulatedInvestment } from "../test-support/simulated-investment.js";
import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import { postLedgerTransaction } from "../src/ledger-posting.js";
import { formatUsdt } from "../src/ledger-safety.js";
import { getSimulationReceipt, getWalletBalances } from "../src/wallet-balances.js";
import { cancelWithdrawal, reserveWithdrawal, submitSimulatedWithdrawal, confirmTestnetWithdrawal } from "../test-support/simulated-withdrawal.js";
import { findWithdrawalDiscrepancies } from "../test-support/reconcile-simulated-withdrawals.js";
import { createSimulationWithdrawalTables } from "../test-support/withdrawal-schema.js";

const mode = process.argv[2];
assert.ok(["seed", "verify"].includes(mode));
const database = mode === "seed" ? "wallet_drill_source" : "wallet_drill_restored";
assert.ok(isDisposablePostgresTarget(process.env.DATABASE_URL, "profino_test"), "Explicit disposable PostgreSQL target required");
const url = new URL(process.env.DATABASE_URL);
url.pathname = "/" + database;
const pool = new pg.Pool({ connectionString: url.href });
async function verifyAccounting() {
  const integrity=await auditLedgerIntegrity(pool);
  assert.equal(integrity.clean,true,JSON.stringify(integrity.counts));
  const liabilities=await reconcileSimulatedLiabilities(pool);
  assert.equal(liabilities.clean,true,JSON.stringify(liabilities.counts));
  const {rows}=await pool.query("SELECT id,account_code FROM ledger_accounts WHERE account_code IN ('drill-reserve','drill-fee')");
  const accounts=Object.fromEntries(rows.map(row=>[row.account_code,row.id]));
  assert.equal(rows.length,2);
  assert.deepEqual(await findSettlementDiscrepancies(pool,accounts["drill-reserve"],accounts["drill-fee"]),[]);
  return {integrity:integrity.counts,liabilities:liabilities.counts};
}
// All five known fixture sequences must remain attached to their original
// columns, and their next generated values must not collide with restored IDs.
async function sequenceSnapshot() {
  const result={};
  for(const table of ["ledger_accounts","ledger_transactions","ledger_entries","simulation_investments","simulation_withdrawals"]){
    const expected=table+"_id_seq";
    const {rows:[binding]}=await pool.query("SELECT pg_get_serial_sequence($1,'id') AS name",["public."+table]);
    assert.equal(binding.name,"public."+expected);
    const {rows:[state]}=await pool.query("SELECT last_value::text AS last_value,is_called FROM public."+expected);
    const {rows:[max]}=await pool.query("SELECT max(id)::text AS maximum FROM public."+table);
    assert.equal(state.is_called,true);
    assert.ok(BigInt(state.last_value)>=BigInt(max.maximum));
    const {rows:[config]}=await pool.query(
      "SELECT increment_by::text,cycle FROM pg_catalog.pg_sequences WHERE schemaname='public' AND sequencename=$1",[expected]);
    assert.deepEqual(config,{increment_by:"1",cycle:false});
    result[table]={...state,...config};
  }
  return result;
}
try {
  const {rows:[identity]}=await pool.query("SELECT current_database() AS name,current_schema() AS schema,current_setting('server_version_num') AS version");
  assert.equal(identity.name,database);
  assert.equal(identity.schema,"public");
  assert.match(identity.version,/^17[0-9]{4}$/);
  if (mode === "seed") {
    await pool.query(await readFile(new URL("../test/fixtures/ledger-contract.sql", import.meta.url), "utf8"));
    await createSimulationWithdrawalTables(pool);
    await pool.query(`
      ALTER TABLE users ADD COLUMN telegram_id bigint, ADD COLUMN status text;
      INSERT INTO users VALUES (1, 7001, 'active');
      INSERT INTO ledger_accounts (user_id, account_code, account_type)
      VALUES (1,'available','AVAILABLE'), (1,'invested','INVESTED'), (1,'profit','PROFIT'), (null,'clearing','CLEARING')
    `);
    const { rows } = await pool.query("SELECT id, account_code FROM ledger_accounts");
    const accounts = Object.fromEntries(rows.map(row => [row.account_code, row.id]));
    await postLedgerTransaction({ pool, transactionType: "simulated-deposit", referenceId: "1", idempotencyKey: "drill-deposit",
      entries: [
        { account_id: accounts.clearing, entry_type: "debit", amount: "25", currency: "USDT" },
        { account_id: accounts.available, entry_type: "credit", amount: "25", currency: "USDT" }
      ]
    });
    const closed = await reserveWithdrawal(pool, 1, "closed", "5");
    await cancelWithdrawal(pool, 1, closed.id);
    await reserveWithdrawal(pool, 1, "open", "7.25");
    // A separate synthetic owner has both an active investment and a pending
    // receipt at the backup cutoff. No real network or signing is involved.
    await pool.query(`
      INSERT INTO users VALUES(2,7002,'active');
      INSERT INTO ledger_accounts(user_id,account_code,account_type) VALUES
       (2,'second-available','AVAILABLE'),(2,'second-invested','INVESTED'),
       (2,'second-profit','PROFIT'),(NULL,'drill-reserve','AVAILABLE'),(NULL,'drill-fee','CLEARING');
      CREATE TABLE simulation_investments(id bigserial PRIMARY KEY,user_id bigint REFERENCES users(id),
       request_id text NOT NULL,plan text NOT NULL,principal integer NOT NULL,
       profit_percent integer NOT NULL,fee_percent integer NOT NULL,opened_at timestamptz NOT NULL DEFAULT now(),
       matures_at timestamptz NOT NULL,settlement_id bigint UNIQUE REFERENCES ledger_transactions(id),
       status text NOT NULL DEFAULT 'active',UNIQUE(user_id,request_id))
    `);
    const {rows:fixtureAccounts}=await pool.query("SELECT id,account_code FROM ledger_accounts");
    const a=Object.fromEntries(fixtureAccounts.map(row=>[row.account_code,row.id]));
    for(const [key,account,amount] of [["second-funding",a["second-available"],"26"],["reserve-funding",a["drill-reserve"],"3.5"]]){
      await postLedgerTransaction({pool,transactionType:"restore-fixture",idempotencyKey:key,entries:[
        {account_id:a.clearing,entry_type:"debit",amount,currency:"USDT"},
        {account_id:account,entry_type:"credit",amount,currency:"USDT"}]});
    }
    const investment=await openSimulatedInvestment(pool,2,"restore-investment","SMART 25");
    await pool.query("UPDATE simulation_investments SET matures_at=now() WHERE id=$1",[investment]);
    const sample=JSON.parse(await readFile(new URL("../test/fixtures/bsc-testnet-transfer.json",import.meta.url),"utf8"));
    const pending=await reserveWithdrawal(pool,2,"restore-pending","1",sample.expected.recipient);
    const payload=Buffer.from("offline-restore-pending");
    const hash="0x"+createHash("sha256").update(payload).digest("hex");
    await submitSimulatedWithdrawal(pool,pending.id,hash,async()=>{},payload);

  }
  const { rows: requests } = await pool.query(
    "SELECT id, request_key, status, release_id FROM simulation_withdrawals WHERE user_id=1 ORDER BY id"
  );
  assert.deepEqual(requests.map(row => [row.request_key, row.status]), [["closed", "cancelled"], ["open", "reserved"]]);
  const balances = await getWalletBalances(pool, 1);
  assert.equal(formatUsdt(balances.AVAILABLE), "17.75000000");
  assert.equal(formatUsdt(balances.WITHDRAWAL_HOLD), "7.25000000");
  const receipt = await getSimulationReceipt(pool, 7001, requests[0].release_id);
  assert.equal(receipt.reference_id, requests[0].id);
  assert.equal(formatUsdt(receipt.amount), "5.00000000");
  assert.deepEqual(await findWithdrawalDiscrepancies(pool), []);
  // Compare the application-visible snapshot across databases before replaying operations.
  const second=await getWalletBalances(pool,2);
  assert.equal(formatUsdt(second.AVAILABLE),"0.00000000");
  assert.equal(formatUsdt(second.INVESTED),"25.00000000");
  assert.equal(formatUsdt(second.WITHDRAWAL_HOLD),"1.00000000");
  const {rows:[investment]}=await pool.query("SELECT * FROM simulation_investments WHERE user_id=2");
  const {rows:[pending]}=await pool.query("SELECT * FROM simulation_withdrawals WHERE user_id=2");
  assert.equal(investment.status,"active");
  assert.equal(pending.status,"pending_receipt");
  const payload=Buffer.from("offline-restore-pending");
  const hash="0x"+createHash("sha256").update(payload).digest("hex");
  assert.equal(pending.submitted_hash,hash);
  assert.deepEqual(pending.simulation_payload,payload);
  // Compare all fixture rows, not just the two displayed account balances.
  // The digest is only synthetic restore comparison evidence, not backup authentication.
  const snapshot={};
  for(const table of ["users","ledger_accounts","ledger_transactions","ledger_entries","simulation_investments","simulation_withdrawals","simulation_reviewers"]){
    const {rows:[row]}=await pool.query("SELECT count(*)::text AS count, coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM "+table+" t");
    snapshot[table]={count:row.count,sha256:createHash("sha256").update(row.body).digest("hex")};
  }
  const accounting=await verifyAccounting();
  const sequences=await sequenceSnapshot();
  console.log(JSON.stringify({ requests, balances, receipt, second, snapshot, accounting, sequences }));
  if (mode === "verify") {
    const posted = "SELECT id FROM ledger_transactions WHERE idempotency_key = 'drill-deposit'";
    await assert.rejects(
      pool.query("UPDATE ledger_transactions SET description = 'restore probe' WHERE id IN (" + posted + ")"),
      { code: "P0001", message: /posted transactions are immutable/i }
    );
    await assert.rejects(
      pool.query("DELETE FROM ledger_entries WHERE transaction_id IN (" + posted + ")"),
      { code: "P0001", message: /entries of posted transactions cannot be changed/i }
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [journal] } = await client.query(
        "INSERT INTO ledger_transactions(transaction_type) VALUES ('restore-probe') RETURNING id"
      );
      await client.query(`INSERT INTO ledger_entries(transaction_id, account_id, entry_type, amount)
        SELECT $1, id, 'credit', 1 FROM ledger_accounts WHERE account_code='available'`, [journal.id]);
      await client.query("UPDATE ledger_transactions SET status='posted' WHERE id=$1", [journal.id]);
      await assert.rejects(client.query("COMMIT"), { code: "P0001", message: /not balanced/i });
      const probe = await client.query("SELECT id FROM ledger_transactions WHERE id=$1", [journal.id]);
      assert.equal(probe.rowCount, 0);
    } finally {
      try { await client.query("ROLLBACK"); }
      finally { client.release(); }
    }
    console.error("Restored ledger rejected posted mutations and rolled back an unbalanced commit.");
    assert.equal(await cancelWithdrawal(pool, 1, requests[0].id), requests[0].release_id);
    assert.equal((await reserveWithdrawal(pool, 1, "open", "7.25")).id, requests[1].id);
    await cancelWithdrawal(pool, 1, requests[1].id);
    const recovered = await getWalletBalances(pool, 1);
    assert.equal(formatUsdt(recovered.AVAILABLE), "25.00000000");
    assert.equal(formatUsdt(recovered.WITHDRAWAL_HOLD), "0.00000000");
    assert.deepEqual(await findWithdrawalDiscrepancies(pool), []);
    const {rows:fixtureAccounts}=await pool.query("SELECT id,account_code FROM ledger_accounts");
    const a=Object.fromEntries(fixtureAccounts.map(row=>[row.account_code,row.id]));
    assert.equal(await openSimulatedInvestment(pool,2,"restore-investment","SMART 25"),investment.id);
    const settle=()=>settleSimulatedInvestment(pool,2,investment.id,a["drill-reserve"],a["drill-fee"]);
    assert.equal(await settle(),await settle());
    let sends=0;
    assert.equal(await submitSimulatedWithdrawal(pool,pending.id,hash,async()=>{sends++;},payload),hash);
    assert.equal(sends,0);
    const sample=JSON.parse(await readFile(new URL("../test/fixtures/bsc-testnet-transfer.json",import.meta.url),"utf8"));
    sample.expected.txHash=hash;
    sample.observation.receipt.transactionHash=hash;
    for(const log of sample.observation.receipt.logs)log.transactionHash=hash;
    const treasury={sender:"0x03e37a3686a553735dd9737a060e4a2c6c018ace",accountId:a.clearing};
    const confirm=()=>confirmTestnetWithdrawal(pool,pending.id,sample.observation,sample.expected,treasury);
    assert.equal(await confirm(),await confirm());
    const final=await getWalletBalances(pool,2);
    assert.equal(formatUsdt(final.AVAILABLE),"27.36000000");
    assert.equal(formatUsdt(final.INVESTED),"0.00000000");
    assert.equal(formatUsdt(final.WITHDRAWAL_HOLD),"0.00000000");
    assert.deepEqual(await findWithdrawalDiscrepancies(pool),[]);
    await verifyAccounting();
    await sequenceSnapshot();
    console.error("Restored active investment and pending synthetic payout replay verified; sequence and accounting checks passed.");
  }
} finally {
  await pool.end();
}
