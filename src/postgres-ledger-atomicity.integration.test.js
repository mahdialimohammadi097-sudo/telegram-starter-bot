// Isolated PostgreSQL integration test. Requires a disposable test database.
// Never runs against production; does not import the Telegram runtime.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {toUsdtUnitsExact} from "./ledger-safety.js";
import {randomUUID} from "node:crypto";
const url=process.env.PROFINO_TEST_DATABASE_URL;
// Fail closed before connecting: these tests create and drop fixture schemas.
if(url){
 const target=new URL(url);
 if(target.protocol!=="postgresql:" || target.hostname!=="127.0.0.1" ||
    target.port!=="5432" || target.username!=="profino_test" ||
    target.pathname!=="/profino_test" || target.search || target.hash)
  throw new Error("Integration tests require the isolated local profino_test database");
}

test("unique event claims and journal writes rollback atomically",{
 skip:!url?"requires PROFINO_TEST_DATABASE_URL":false
},async()=>{
 const pool=new pg.Pool({connectionString:url,max:3});
 const admin=await pool.connect();
 try{
  await admin.query('BEGIN');
  await admin.query('CREATE TEMP TABLE evidence (event_key text PRIMARY KEY) ON COMMIT DROP');
  await admin.query('CREATE TEMP TABLE journal (event_key text REFERENCES evidence(event_key), amount numeric(36,18) NOT NULL CHECK(amount>0)) ON COMMIT DROP');
  await admin.query("INSERT INTO evidence VALUES ('event-a')");
  await admin.query("INSERT INTO journal VALUES ('event-a',10.00000000)");
  await assert.rejects(admin.query("INSERT INTO evidence VALUES ('event-a')"),e=>e.code==="23505");
  await admin.query('ROLLBACK');
  // A failed statement aborts the entire transaction, including its earlier journal.
  await admin.query('BEGIN');
  const count=await admin.query("SELECT count(*)::int AS n FROM pg_class WHERE relname='evidence' AND relnamespace=pg_my_temp_schema()");
  assert.equal(count.rows[0].n,0);
  await admin.query('ROLLBACK');
 }finally{admin.release();await pool.end();}
});

test("concurrent PostgreSQL transactions cannot claim the same deposit",{
 skip:!url?"requires PROFINO_TEST_DATABASE_URL":false,
 timeout:15000
},async()=>{
 // Only a disposable CI database may be supplied. Never use a production URL.
 const pool=new pg.Pool({connectionString:url,max:3});
 const schema="test_"+randomUUID().replaceAll("-","").slice(0,24);
 const quoted='"'+schema+'"';
 const admin=await pool.connect();
 let first,second;
 try{
  await admin.query("CREATE SCHEMA "+quoted);
  await admin.query("CREATE TABLE "+quoted+".claims (event_key text PRIMARY KEY)");
  await admin.query("CREATE TABLE "+quoted+".journal (event_key text NOT NULL REFERENCES "+quoted+".claims(event_key), amount numeric(36,18) NOT NULL CHECK(amount>0))");
  first=await pool.connect();
  second=await pool.connect();
  await first.query("BEGIN");
  await second.query("BEGIN");
  await first.query("INSERT INTO "+quoted+".claims(event_key) VALUES ($1)",["event-same"]);
  await first.query("INSERT INTO "+quoted+".journal(event_key,amount) VALUES ($1,$2)",["event-same","10.00000000"]);
  // The second writer waits on the first writer's unique-key decision.
  const secondAttempt=second.query("INSERT INTO "+quoted+".claims(event_key) VALUES ($1)",["event-same"]);
  await first.query("COMMIT");
  await assert.rejects(secondAttempt,e=>e.code==="23505");
  await second.query("ROLLBACK");
  const claims=await admin.query("SELECT count(*)::int AS n FROM "+quoted+".claims");
  const entries=await admin.query("SELECT count(*)::int AS n FROM "+quoted+".journal");
  assert.equal(claims.rows[0].n,1);
  assert.equal(entries.rows[0].n,1);
 }finally{
  if(first){try{await first.query("ROLLBACK")}catch{}first.release()}
  if(second){try{await second.query("ROLLBACK")}catch{}second.release()}
  try{await admin.query("DROP SCHEMA IF EXISTS "+quoted+" CASCADE")}finally{admin.release();await pool.end()}
 }
});

test("failed journal posting rolls back its claimed deposit identity",{
 skip:!url?"requires PROFINO_TEST_DATABASE_URL":false,
 timeout:15000
},async()=>{
 const pool=new pg.Pool({connectionString:url,max:2});
 const schema="test_"+randomUUID().replaceAll("-","").slice(0,24);
 const quoted='"'+schema+'"';
 const client=await pool.connect();
 try{
  await client.query("CREATE SCHEMA "+quoted);
  await client.query("CREATE TABLE "+quoted+".claims(event_key text PRIMARY KEY)");
  await client.query("CREATE TABLE "+quoted+".journal(event_key text NOT NULL REFERENCES "+quoted+".claims(event_key), amount numeric(36,18) NOT NULL CHECK(amount>0))");
  await client.query("BEGIN");
  await client.query("INSERT INTO "+quoted+".claims(event_key) VALUES ($1)",["event-failed"]);
  await assert.rejects(client.query("INSERT INTO "+quoted+".journal(event_key,amount) VALUES ($1,$2)",["event-failed","0"]),e=>e.code==="23514");
  await client.query("ROLLBACK");
  const claims=await client.query("SELECT count(*)::int AS n FROM "+quoted+".claims");
  const journal=await client.query("SELECT count(*)::int AS n FROM "+quoted+".journal");
  assert.equal(claims.rows[0].n,0);
  assert.equal(journal.rows[0].n,0);
 }finally{
  try{await client.query("ROLLBACK")}catch{}
  try{await client.query("DROP SCHEMA IF EXISTS "+quoted+" CASCADE")}finally{client.release();await pool.end()}
 }
});

test("competing deposit claim succeeds after the first transaction rolls back",{
 skip:!url?"requires PROFINO_TEST_DATABASE_URL":false,
 timeout:15000
},async()=>{
 const pool=new pg.Pool({connectionString:url,max:3});
 const schema="test_"+randomUUID().replaceAll("-","").slice(0,24);
 const quoted='"'+schema+'"';
 const admin=await pool.connect();
 let first,second;
 try{
  await admin.query("CREATE SCHEMA "+quoted);
  await admin.query("CREATE TABLE "+quoted+".claims(event_key text PRIMARY KEY)");
  first=await pool.connect();
  second=await pool.connect();
  await first.query("BEGIN");
  await second.query("BEGIN");
  await first.query("INSERT INTO "+quoted+".claims VALUES ($1)",["event-retry"]);
  const pending=second.query("INSERT INTO "+quoted+".claims VALUES ($1)",["event-retry"]);
  await first.query("ROLLBACK");
  const result=await pending;
  assert.equal(result.rowCount,1);
  await second.query("COMMIT");
  const count=await admin.query("SELECT count(*)::int AS n FROM "+quoted+".claims");
  assert.equal(count.rows[0].n,1);
 }finally{
  if(first){try{await first.query("ROLLBACK")}catch{}first.release()}
  if(second){try{await second.query("ROLLBACK")}catch{}second.release()}
  try{await admin.query("DROP SCHEMA IF EXISTS "+quoted+" CASCADE")}finally{admin.release();await pool.end()}
 }
});

test("PostgreSQL numeric(36,18) preserves exact eight-decimal USDT journal balance",{
 skip:!url?"requires PROFINO_TEST_DATABASE_URL":false,
 timeout:15000
},async()=>{
 const pool=new pg.Pool({connectionString:url,max:1});
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  await client.query("CREATE TEMP TABLE journal_precision (account_id bigint NOT NULL, entry_type text NOT NULL CHECK(entry_type IN ('debit','credit')), amount numeric(36,18) NOT NULL CHECK(amount>0)) ON COMMIT DROP");
  await client.query("INSERT INTO journal_precision VALUES (1,'debit',$1::numeric),(2,'credit',$1::numeric)",["0.00000001"]);
  const result=await client.query(`SELECT
   SUM(CASE WHEN entry_type='credit' THEN amount ELSE -amount END)::text AS net,
   MIN(amount)::text AS smallest
   FROM journal_precision`);
  assert.equal(result.rows[0].net,"0.000000000000000000");
  assert.equal(result.rows[0].smallest,"0.000000010000000000");
  await assert.rejects(client.query("INSERT INTO journal_precision VALUES (3,'credit',0)"),e=>e.code==="23514");
  await client.query("ROLLBACK");
 }finally{
  try{await client.query("ROLLBACK")}catch{}
  client.release();await pool.end();
 }
});

test("row lock serializes competing debits and prevents available-balance overdraft",{
 skip:!url?"requires PROFINO_TEST_DATABASE_URL":false,
 timeout:15000
},async()=>{
 const pool=new pg.Pool({connectionString:url,max:3});
 const schema="test_"+randomUUID().replaceAll("-","").slice(0,24);
 const quoted='"'+schema+'"';
 const admin=await pool.connect();
 let first,second;
 try{
  await admin.query("CREATE SCHEMA "+quoted);
  await admin.query("CREATE TABLE "+quoted+".balances (account_id bigint PRIMARY KEY, available numeric(36,18) NOT NULL CHECK(available>=0))");
  await admin.query("INSERT INTO "+quoted+".balances VALUES (1,10)");
  first=await pool.connect();
  second=await pool.connect();
  await first.query("BEGIN");
  await second.query("BEGIN");
  const firstDebit=await first.query("UPDATE "+quoted+".balances SET available=available-$1::numeric WHERE account_id=1 AND available >= $1::numeric RETURNING available::text",["7"]);
  assert.equal(firstDebit.rowCount,1);
  const pending=second.query("UPDATE "+quoted+".balances SET available=available-$1::numeric WHERE account_id=1 AND available >= $1::numeric RETURNING available::text",["7"]);
  await first.query("COMMIT");
  const secondDebit=await pending;
  assert.equal(secondDebit.rowCount,0);
  await second.query("COMMIT");
  const result=await admin.query("SELECT available::text AS balance FROM "+quoted+".balances WHERE account_id=1");
  assert.equal(result.rows[0].balance,"3.000000000000000000");
 }finally{
  if(first){try{await first.query("ROLLBACK")}catch{}first.release()}
  if(second){try{await second.query("ROLLBACK")}catch{}second.release()}
  try{await admin.query("DROP SCHEMA IF EXISTS "+quoted+" CASCADE")}finally{admin.release();await pool.end()}
 }
});

test("ledger-derived available balance cannot be spent twice under account row lock",{
 skip:!url?"requires PROFINO_TEST_DATABASE_URL":false,
 timeout:15000
},async()=>{
 const pool=new pg.Pool({connectionString:url,max:3});
 const schema="test_"+randomUUID().replaceAll("-","").slice(0,24);
 const quoted='"'+schema+'"';
 const admin=await pool.connect();
 let first,second;
 try{
  await admin.query("CREATE SCHEMA "+quoted);
  await admin.query("CREATE TABLE "+quoted+".accounts(id bigint PRIMARY KEY)");
  await admin.query("CREATE TABLE "+quoted+".entries(account_id bigint REFERENCES "+quoted+".accounts(id), entry_type text CHECK(entry_type IN ('credit','debit')), amount numeric(36,18) CHECK(amount>0))");
  await admin.query("INSERT INTO "+quoted+".accounts VALUES (1)");
  await admin.query("INSERT INTO "+quoted+".entries VALUES (1,'credit',10)");
  const spend=async(client)=>{
   await client.query("SELECT id FROM "+quoted+".accounts WHERE id=1 FOR UPDATE");
   const balance=await client.query("SELECT COALESCE(SUM(CASE WHEN entry_type='credit' THEN amount ELSE -amount END),0)::text AS available FROM "+quoted+".entries WHERE account_id=1");
   if(toUsdtUnitsExact(balance.rows[0].available.replace(/(\.\d{8})0+$/,"$1"))<700000000n)return false;
   await client.query("INSERT INTO "+quoted+".entries VALUES (1,'debit',7)");
   return true;
  };
  first=await pool.connect();
  second=await pool.connect();
  await first.query("BEGIN");
  await second.query("BEGIN");
  assert.equal(await spend(first),true);
  const pending=spend(second);
  await first.query("COMMIT");
  assert.equal(await pending,false);
  await second.query("COMMIT");
  const balance=await admin.query("SELECT SUM(CASE WHEN entry_type='credit' THEN amount ELSE -amount END)::text AS available FROM "+quoted+".entries");
  assert.equal(balance.rows[0].available,"3.000000000000000000");
 }finally{
  if(first){try{await first.query("ROLLBACK")}catch{}first.release()}
  if(second){try{await second.query("ROLLBACK")}catch{}second.release()}
  try{await admin.query("DROP SCHEMA IF EXISTS "+quoted+" CASCADE")}finally{admin.release();await pool.end()}
 }
});
