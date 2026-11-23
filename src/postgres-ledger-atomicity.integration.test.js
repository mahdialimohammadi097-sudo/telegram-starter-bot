// Isolated PostgreSQL integration test. Requires a disposable test database.
// Never runs against production; does not import the Telegram runtime.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {randomUUID} from "node:crypto";
const url=process.env.PROFINO_TEST_DATABASE_URL;
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
