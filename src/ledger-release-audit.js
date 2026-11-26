// Operator-only evidence from one bounded read-only snapshot.
// This does not authorize production financial activity.
import {inspectLedgerIntegrity} from "./ledger-integrity-audit.js";
import {inspectLedgerTriggerContract} from "./ledger-trigger-contract-audit.js";
import {inspectReviewedLedgerBodies} from "./ledger-reviewed-bodies.js";
import {runReadOnlyDepositAudit} from "./read-only-deposit-audit.js";

export async function collectLedgerReleaseEvidence(pool,{schema="public"}={}) {
  if(typeof schema!=="string"||!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid ledger schema");
  return runReadOnlyDepositAudit(pool,async client=>{
    // Pin name/operator resolution before any catalog comparison or deparse.
    // The later integrity scan independently verifies its own visibility.
    const path=await client.query("SET LOCAL search_path = pg_catalog");
    const state=await client.query("SELECT pg_catalog.current_setting('search_path') AS search_path");
    if(path?.command!=="SET"||state.rows?.length!==1||state.rows[0].search_path!=="pg_catalog"){
      throw new Error("Ledger catalog search path incompatible");
    }
    const {rows}=await client.query(`
      SELECT c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
        EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) AS has_policy,
        EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i
          WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inheritance_link,
        EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite rw
          WHERE rw.ev_class=c.oid) AS rewrite_rule
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname IN ('ledger_accounts','ledger_transactions','ledger_entries')
    `,[schema]);
    if(rows?.length!==3||new Set(rows.map(r=>r.relname)).size!==3||
      rows.some(r=>r.relkind!=="r"||r.relpersistence!=="p")){
      throw new Error("Ledger evidence requires three permanent ordinary tables");
    }
    // Inheritance can expand a normal SELECT beyond the reviewed tables.
    // Rewrite rules can alter the meaning of future writes without a trigger.
    // Fail closed on either; do not return object names or rule definitions.
    if(rows.some(r=>["inheritance_link","rewrite_rule","relrowsecurity","relforcerowsecurity","has_policy"].some(key=>typeof r[key]!=="boolean"))){
      throw new Error("Incomplete ledger relation evidence");
    }
    const relations={
      inheritanceFree:rows.every(r=>r.inheritance_link===false),
      rewriteRuleFree:rows.every(r=>r.rewrite_rule===false),
      rowSecurityFree:rows.every(r=>r.relrowsecurity===false&&r.relforcerowsecurity===false),
      rowPolicyFree:rows.every(r=>r.has_policy===false)
    };
    if(!relations.inheritanceFree||!relations.rewriteRuleFree){
      throw new Error("Ledger relations contain unreviewed inheritance or rewrite rules");
    }
    // Historical ledger contract contains no reviewed RLS policy. Even a
    // privileged audit session may bypass a policy that filters runtime rows.
    // Do not qualify an unreviewed policy, including dormant policies.
    if(!relations.rowSecurityFree||!relations.rowPolicyFree){
      throw new Error("Ledger relations contain unreviewed row security configuration");
    }
    // Compare the historical reviewed column contract before interpreting any
    // amounts. Floating point, unexpected precision and nullable required
    // columns must not silently qualify a clean empty ledger.
    const columnRows=(await client.query(`
      SELECT c.relname AS table_name,a.attname AS column_name,
        pg_catalog.format_type(a.atttypid,a.atttypmod) AS data_type,
        a.attnotnull AS not_null,a.attgenerated='' AS ordinary,
        tn.nspname='pg_catalog' AS builtin
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
      JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
      WHERE n.nspname=$1 AND c.relname IN ('ledger_accounts','ledger_transactions','ledger_entries')
        AND a.attnum>0 AND NOT a.attisdropped
    `,[schema])).rows;
    if(!Array.isArray(columnRows))throw new Error("Incomplete ledger column evidence");
    const expectedColumns={
      ledger_accounts:[
        ["id","bigint",true],["user_id","bigint",false],
        ["account_code","character varying(100)",true],
        ["account_type","character varying(30)",true],
        ["currency","character varying(10)",true],
        ["created_at","timestamp with time zone",true]
      ],
      ledger_transactions:[
        ["id","bigint",true],["transaction_type","character varying(30)",true],
        ["reference_id","character varying(100)",false],
        ["idempotency_key","character varying(150)",null],
        ["description","text",false],["status","character varying(20)",true],
        ["created_at","timestamp with time zone",true]
      ],
      ledger_entries:[
        ["id","bigint",true],["transaction_id","bigint",true],["account_id","bigint",true],
        ["entry_type","character varying(10)",true],["amount","numeric(36,18)",true],
        ["currency","character varying(10)",true],["created_at","timestamp with time zone",true]
      ]
    };
    const columnChecks=Object.entries(expectedColumns).flatMap(([table,columns])=>
      columns.map(([column,type,notNull])=>{
        const matches=columnRows.filter(x=>x.table_name===table&&x.column_name===column);
        const row=matches[0];
        return {table,column,compatible:matches.length===1&&row.data_type===type&&
          row.builtin===true&&row.ordinary===true&&typeof row.not_null==="boolean"&&
          (notNull===null||row.not_null===notNull)};
      }));
    const columnContract={
      checks:columnChecks,compatible:columnChecks.every(x=>x.compatible),
      // Historical fixtures allow null idempotency keys. Record this gap
      // separately; a matching fixture is not a production release gate.
      idempotencyNotNull:columnRows.some(x=>x.table_name==="ledger_transactions"&&
        x.column_name==="idempotency_key"&&x.not_null===true),
      storagePrecision:36,storageScale:18
    };
    if(!columnContract.compatible)throw new Error("Ledger column contract incompatible");
    // The historical schema uses three independently owned BIGSERIAL IDs.
    // A valid primary key alone does not establish safe ID generation.
    const sequenceRows=(await client.query(`
      SELECT c.relname AS table_name,
        sn.nspname=$1 AND a.attidentity='' AND a.atttypid='pg_catalog.int8'::regtype
          AND s.relpersistence='p' AND q.seqtypid='pg_catalog.int8'::regtype
          AND q.seqincrement=1 AND q.seqmin=1 AND q.seqmax=9223372036854775807
          AND q.seqstart=1 AND NOT q.seqcycle
          AND pg_catalog.pg_get_expr(ad.adbin,ad.adrelid)=
            pg_catalog.format('nextval(%L::regclass)',s.oid::regclass::text)
          AS compatible
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='id'
      JOIN pg_catalog.pg_depend d ON d.refclassid='pg_catalog.pg_class'::regclass
        AND d.refobjid=c.oid AND d.refobjsubid=a.attnum
        AND d.classid='pg_catalog.pg_class'::regclass AND d.objsubid=0 AND d.deptype='a'
      JOIN pg_catalog.pg_class s ON s.oid=d.objid AND s.relkind='S'
      JOIN pg_catalog.pg_namespace sn ON sn.oid=s.relnamespace
      JOIN pg_catalog.pg_sequence q ON q.seqrelid=s.oid
      LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid=c.oid AND ad.adnum=a.attnum
      WHERE n.nspname=$1 AND c.relname IN ('ledger_accounts','ledger_transactions','ledger_entries')
    `,[schema])).rows;
    if(!Array.isArray(sequenceRows))throw new Error("Incomplete ledger sequence evidence");
    const sequenceChecks=Object.keys(expectedColumns).map(table=>{
      const matches=sequenceRows.filter(row=>row.table_name===table);
      return {table,compatible:matches.length===1&&matches[0].compatible===true};
    });
    const generatedIds={checks:sequenceChecks,compatible:sequenceChecks.every(x=>x.compatible),
      currentSequencePositionVerified:false};
    // A clean current snapshot is insufficient if duplicate identities are
    // not constrained by the database. Inspect immediate, valid, nonpartial
    // constraint-backed unique indexes, not merely their names.
    const identityRows=(await client.query(`
      SELECT c.relname AS table_name,k.contype,
        ARRAY(SELECT a.attname::text
          FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY AS key(attnum,pos)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=key.attnum
          ORDER BY key.pos) AS columns,
        k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
          AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
          AND i.indimmediate AND i.indpred IS NULL AND i.indexprs IS NULL
          AND i.indrelid=c.oid AND i.indnkeyatts=pg_catalog.cardinality(k.conkey)
          AND (k.contype<>'p' OR i.indisprimary) AS compatible
      FROM pg_catalog.pg_constraint k
      JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_index i ON i.indexrelid=k.conindid
      WHERE n.nspname=$1 AND c.relname IN ('ledger_accounts','ledger_transactions','ledger_entries')
        AND k.contype IN ('p','u')
    `,[schema])).rows;
    if(!Array.isArray(identityRows))throw new Error("Incomplete ledger identity evidence");
    const expected=[
      ["ledger_accounts","p",["id"]],
      ["ledger_transactions","p",["id"]],
      ["ledger_entries","p",["id"]],
      ["ledger_accounts","u",["account_code"]],
      ["ledger_accounts","u",["user_id","account_type","currency"]],
      ["ledger_transactions","u",["idempotency_key"]]
    ];
    const identities=expected.map(([table,type,columns])=>({
      table,type,columns,
      compatible:identityRows.some(row=>row.table_name===table&&row.contype===type&&
        row.compatible===true&&Array.isArray(row.columns)&&
        row.columns.length===columns.length&&columns.every((name,index)=>row.columns[index]===name))
    }));
    const identityConstraints={checks:identities,compatible:identities.every(x=>x.compatible)};
    // Validate the reviewed foreign-key links and their internal enforcement
    // triggers. An empty ledger cannot demonstrate referential integrity.
    const foreignRows=(await client.query(`
      SELECT c.relname AS table_name,a.attname AS column_name,
        target.relname AS target_table,tn.nspname AS target_schema,
        ta.attname AS target_column,
        k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
          AND k.confupdtype='a' AND k.confdeltype='a' AND k.confmatchtype='s'
          AND target.relkind='r' AND target.relpersistence='p'
          AND (SELECT count(*) FROM pg_catalog.pg_trigger t
               WHERE t.tgconstraint=k.oid AND t.tgisinternal)=4
          AND (SELECT count(*) FROM pg_catalog.pg_trigger t
               WHERE t.tgconstraint=k.oid AND t.tgisinternal
                 AND t.tgrelid=c.oid AND t.tgenabled IN ('O','A'))=2
          AND (SELECT count(*) FROM pg_catalog.pg_trigger t
               WHERE t.tgconstraint=k.oid AND t.tgisinternal
                 AND t.tgrelid=target.oid AND t.tgenabled IN ('O','A'))=2
          AS compatible
      FROM pg_catalog.pg_constraint k
      JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_class target ON target.oid=k.confrelid
      JOIN pg_catalog.pg_namespace tn ON tn.oid=target.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.conkey[1]
      JOIN pg_catalog.pg_attribute ta ON ta.attrelid=target.oid AND ta.attnum=k.confkey[1]
      WHERE n.nspname=$1 AND c.relname IN ('ledger_accounts','ledger_entries')
        AND k.contype='f' AND pg_catalog.cardinality(k.conkey)=1
        AND pg_catalog.cardinality(k.confkey)=1
    `,[schema])).rows;
    if(!Array.isArray(foreignRows))throw new Error("Incomplete ledger reference evidence");
    const expectedReferences=[
      ["ledger_accounts","user_id","users"],
      ["ledger_entries","transaction_id","ledger_transactions"],
      ["ledger_entries","account_id","ledger_accounts"]
    ];
    const references=expectedReferences.map(([table,column,target])=>({
      table,column,target,
      compatible:foreignRows.some(row=>row.table_name===table&&row.column_name===column&&
        row.target_table===target&&row.target_schema===schema&&row.target_column==="id"&&row.compatible===true)
    }));
    const foreignKeys={checks:references,compatible:references.every(x=>x.compatible)};
    // Require the reviewed positive-amount CHECK, not just its name or
    // the absence of invalid amounts today. Limit accepted deparse forms
    // to the fixed historical expression, allowing formatting differences.
    const amountChecks=(await client.query(`
      SELECT k.convalidated,k.connoinherit,
        pg_catalog.pg_get_expr(k.conbin,k.conrelid,false) AS expression
      FROM pg_catalog.pg_constraint k
      JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='amount'
      WHERE n.nspname=$1 AND c.relname='ledger_entries' AND k.contype='c'
        AND pg_catalog.cardinality(k.conkey)=1 AND k.conkey[1]=a.attnum
    `,[schema])).rows;
    if(!Array.isArray(amountChecks))throw new Error("Incomplete amount constraint evidence");
    const positiveAmount=amountChecks.some(x=>x.convalidated===true&&x.connoinherit===false&&
      typeof x.expression==="string"&&
      ["amount>0::numeric","amount>0"].includes(x.expression.replace(/[()\s]/g,"")));
    const amountConstraint={positiveAmount,compatible:positiveAmount};
    // Historical CHECKs must constrain the exact reviewed direction/status
    // sets. Preserve quoted literal contents while normalizing deparse
    // whitespace and parentheses outside those literals.
    const valueRows=(await client.query(`
      SELECT c.relname AS table_name,a.attname AS column_name,
        k.convalidated,k.connoinherit,
        pg_catalog.pg_get_expr(k.conbin,k.conrelid,false) AS expression
      FROM pg_catalog.pg_constraint k
      JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND k.conkey[1]=a.attnum
      WHERE n.nspname=$1 AND k.contype='c' AND pg_catalog.cardinality(k.conkey)=1
        AND ((c.relname='ledger_entries' AND a.attname='entry_type')
          OR (c.relname='ledger_transactions' AND a.attname='status'))
    `,[schema])).rows;
    if(!Array.isArray(valueRows))throw new Error("Incomplete ledger value constraint evidence");
    const normalizeExpression=value=>value.split("'").map((part,index)=>
      index%2===0?part.replace(/[()\s]/g,""):part).join("'");
    const valueContracts=[
      ["ledger_entries","entry_type",["debit","credit"]],
      ["ledger_transactions","status",["pending","posted","reversed"]]
    ];
    const valueChecks=valueContracts.map(([table,column,values])=>{
      const varcharArray=values.map(value=>"'"+value+"'::charactervarying").join(",");
      const textArray=values.map(value=>"'"+value+"'::text").join(",");
      const forms=[
        column+"::text=ANYARRAY["+varcharArray+"]::text[]",
        column+"::text=ANYARRAY["+textArray+"]"
      ];
      return {table,column,compatible:valueRows.some(row=>row.table_name===table&&
        row.column_name===column&&row.convalidated===true&&row.connoinherit===false&&
        typeof row.expression==="string"&&forms.includes(normalizeExpression(row.expression)))};
    });
    const valueConstraints={checks:valueChecks,compatible:valueChecks.every(x=>x.compatible)};
    const integrity=await inspectLedgerIntegrity(client,{schema});
    const triggers=await inspectLedgerTriggerContract(client,{schema});
    const reviewedBodies=await inspectReviewedLedgerBodies(client,{schema});
    return {
      audit:"ledger-release-evidence",scope:"internal-ledger-and-trigger-shape-only",
      sameSnapshot:true,
      relations,columnContract,generatedIds,identityConstraints,foreignKeys,amountConstraint,valueConstraints,integrity,triggers,reviewedBodies,
      checksPassed:columnContract.compatible===true&&generatedIds.compatible===true&&identityConstraints.compatible===true&&foreignKeys.compatible===true&&amountConstraint.compatible===true&&valueConstraints.compatible===true&&integrity.clean===true&&triggers.compatible===true&&reviewedBodies.match===true,
      custodyVerified:false,financialActivationReady:false,productionReady:false
    };
  });
}
