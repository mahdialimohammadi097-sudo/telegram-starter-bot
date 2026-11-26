import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {getWalletBalances, IncompleteWalletError} from "./wallet-balances.js";
import {isDisposablePostgresTarget} from "../test-support/disposable-postgres-target.js";

const url=process.env.CATALOG_REHEARSAL_URL;
test("wallet balance rejects duplicate account roles instead of combining them",
 {skip:!isDisposablePostgresTarget(url,"catalog_rehearsal")},async()=>{
  const pool=new pg.Pool({connectionString:url,max:1});
  let client;
  try{
    client=await pool.connect();
    await client.query("BEGIN");
    // Deliberately omit the uniqueness constraint to model damaged catalog
    // state. All tables and amounts are synthetic and transaction-local.
    await client.query(`CREATE TEMP TABLE ledger_accounts(id bigint PRIMARY KEY,user_id bigint,account_type text,currency text) ON COMMIT DROP;
      CREATE TEMP TABLE ledger_transactions(id bigint PRIMARY KEY,status text) ON COMMIT DROP;
      CREATE TEMP TABLE ledger_entries(account_id bigint,transaction_id bigint,entry_type text,amount numeric(28,8),currency text) ON COMMIT DROP;
      SET LOCAL search_path=pg_temp,pg_catalog;
      INSERT INTO ledger_accounts VALUES (1,11,'AVAILABLE','USDT'),(2,11,'INVESTED','USDT'),(3,11,'PROFIT','USDT'),(4,22,'AVAILABLE','USDT');
      INSERT INTO ledger_transactions VALUES (1,'posted'),(2,'pending');
      INSERT INTO ledger_entries VALUES (1,1,'credit',10,'USDT'),(1,2,'credit',99,'USDT'),(4,1,'credit',100,'USDT')`);
    assert.equal((await getWalletBalances(client,11)).AVAILABLE,"10.00000000");
    await assert.rejects(getWalletBalances(client,22),IncompleteWalletError);
    await client.query("INSERT INTO ledger_accounts VALUES (5,11,'AVAILABLE','USDT')");
    await assert.rejects(getWalletBalances(client,11),/Wallet account identity is ambiguous/);
    await client.query("DELETE FROM ledger_accounts WHERE id=5");
    assert.equal((await getWalletBalances(client,11)).AVAILABLE,"10.00000000");
    await client.query("INSERT INTO ledger_accounts VALUES (6,11,'WITHDRAWAL_HOLD','USDT'),(7,11,'WITHDRAWAL_HOLD','USDT')");
    await assert.rejects(getWalletBalances(client,11),/Wallet account identity is ambiguous/);
    await client.query("ROLLBACK");
  }finally{
    if(client)client.release(true);
    await pool.end();
  }
});
