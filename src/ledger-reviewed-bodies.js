// Exact reviewed historical fixture comparison, not proof of live semantics.
// Do not return live function bodies or substitute this for role/search-path review.
const reviewed=Object.freeze({
  "validate_posted_transaction": "DECLARE\n    v_status VARCHAR;\nBEGIN\n    SELECT status\n    INTO v_status\n    FROM ledger_transactions\n    WHERE id = p_transaction_id;\n\n    IF NOT FOUND OR v_status <> 'posted' THEN\n        RETURN;\n    END IF;\n\n    IF NOT EXISTS (\n        SELECT 1\n        FROM ledger_entries\n        WHERE transaction_id = p_transaction_id\n    ) THEN\n        RAISE EXCEPTION\n            'Posted transaction % has no ledger entries',\n            p_transaction_id;\n    END IF;\n\n    IF EXISTS (\n        SELECT currency\n        FROM ledger_entries\n        WHERE transaction_id = p_transaction_id\n        GROUP BY currency\n        HAVING\n            COUNT(*) < 2\n            OR SUM(\n                CASE\n                    WHEN entry_type = 'debit' THEN amount\n                    ELSE 0\n                END\n            ) <>\n            SUM(\n                CASE\n                    WHEN entry_type = 'credit' THEN amount\n                    ELSE 0\n                END\n            )\n    ) THEN\n        RAISE EXCEPTION\n            'Transaction % is not balanced',\n            p_transaction_id;\n    END IF;\nEND;",
  "check_ledger_balance": "DECLARE\n    v_transaction_id BIGINT;\n    v_status VARCHAR;\nBEGIN\n    IF TG_TABLE_NAME = 'ledger_transactions' THEN\n        v_transaction_id := NEW.id;\n        PERFORM validate_posted_transaction(v_transaction_id);\n        RETURN NULL;\n    END IF;\n\n    IF TG_OP = 'DELETE' THEN\n        PERFORM validate_posted_transaction(OLD.transaction_id);\n    ELSIF TG_OP = 'UPDATE' THEN\n        PERFORM validate_posted_transaction(OLD.transaction_id);\n        PERFORM validate_posted_transaction(NEW.transaction_id);\n    ELSE\n        PERFORM validate_posted_transaction(NEW.transaction_id);\n    END IF;\n\n    RETURN NULL;\nEND;",
  "protect_posted_entries": "DECLARE\n    v_status VARCHAR;\n    v_id BIGINT;\nBEGIN\n    IF TG_OP IN ('UPDATE', 'DELETE') THEN\n        SELECT status INTO v_status\n        FROM ledger_transactions\n        WHERE id = OLD.transaction_id\n        FOR UPDATE;\n\n        IF v_status = 'posted' THEN\n            RAISE EXCEPTION\n                'Entries of posted transactions cannot be changed.';\n        END IF;\n    END IF;\n\n    IF TG_OP IN ('INSERT', 'UPDATE') THEN\n        SELECT status INTO v_status\n        FROM ledger_transactions\n        WHERE id = NEW.transaction_id\n        FOR UPDATE;\n\n        IF v_status = 'posted' THEN\n            RAISE EXCEPTION\n                'Cannot add entries to a posted transaction.';\n        END IF;\n    END IF;\n\n    RETURN CASE\n        WHEN TG_OP = 'DELETE' THEN OLD\n        ELSE NEW\n    END;\nEND;",
  "protect_posted_transaction": "BEGIN\n    IF OLD.status = 'posted' THEN\n        RAISE EXCEPTION\n            'Posted transactions are immutable. Use a reversal transaction.';\n    END IF;\n\n    RETURN CASE\n        WHEN TG_OP = 'DELETE' THEN OLD\n        ELSE NEW\n    END;\nEND;"
});

export async function inspectReviewedLedgerBodies(client,{schema="public"}={}){
  if(typeof schema!=="string"||!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))throw new Error("Invalid ledger schema");
  const {rows}=await client.query(`
    SELECT p.proname,p.prosrc,p.prosecdef,p.prokind,p.provolatile,p.proconfig,l.lanname,
      p.pronargs::int AS args,p.proargtypes[0]='pg_catalog.int8'::regtype AS bigint_arg,
      p.prorettype='pg_catalog.trigger'::regtype AS trigger_result,
      p.prorettype='pg_catalog.void'::regtype AS void_result
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE n.nspname=$1 AND p.proname=ANY($2::text[])
  `,[schema,Object.keys(reviewed)]);
  if(!Array.isArray(rows))throw new Error("Incomplete ledger function evidence");
  const checks=Object.entries(reviewed).map(([name,body])=>{
    const candidates=rows.filter(r=>r.proname===name);
    const p=candidates[0];
    const helper=name==="validate_posted_transaction";
    return {name,match:candidates.length===1&&p.prosrc?.trim()===body&&p.prosecdef===false&&
      p.prokind==="f"&&p.provolatile==="v"&&p.proconfig===null&&p.lanname==="plpgsql"&&
      (helper?p.args===1&&p.bigint_arg===true&&p.void_result===true:p.args===0&&p.trigger_result===true)};
  });
  return {scope:"reviewed-historical-fixture-comparison",checks,match:checks.every(c=>c.match),
    functionResolutionVerified:false,productionReady:false};
}
