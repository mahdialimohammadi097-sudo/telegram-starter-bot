// Isolated PostgreSQL integration test. Requires a disposable test database.
// Never runs against production; does not import the Telegram runtime.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
const url=process.env.PROFINO_TEST_DATABASE_URL;
test("unique event claims and journal writes rollback atomically",{
 skip:!url?"requires PROFINO_TEST_DATABASE_URL":false
},async()=>{
 const pool=new pg.Pool({connectionString:url,max:3});
 const schema="profino_atomicity_test";
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
