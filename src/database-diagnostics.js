const CORE_TABLES = [
  "users",
  "admin_users",
  "ledger_accounts",
  "ledger_transactions",
  "ledger_entries",
  "scheduled_posts",
  "scheduled_post_history",
  "admin_audit_logs"
];

export async function inspectCoreSchema(pool) {
  const [tablesResult, columnsResult, constraintsResult] = await Promise.all([
    pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_type = 'BASE TABLE'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [CORE_TABLES]
    ),
    pool.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = ANY($1::text[])
       ORDER BY table_name, ordinal_position`,
      [CORE_TABLES]
    ),
    pool.query(
      `SELECT c.relname AS table_name, con.conname AS constraint_name,
              con.contype AS constraint_type,
              pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema()
         AND c.relname = ANY($1::text[])
       ORDER BY c.relname, con.conname`,
      [CORE_TABLES]
    )
  ]);

  return {
    expectedTables: CORE_TABLES,
    existingTables: tablesResult.rows.map(row => row.table_name),
    columns: columnsResult.rows,
    constraints: constraintsResult.rows
  };
}

export function formatCoreSchema(snapshot) {
  const existing = new Set(snapshot.existingTables);
  return snapshot.expectedTables.map(tableName => {
    if (!existing.has(tableName)) {
      return "TABLE: " + tableName + "\\nNOT FOUND";
    }

    const columns = snapshot.columns.filter(row => row.table_name === tableName);
    const constraints = snapshot.constraints.filter(row => row.table_name === tableName);
    const columnLines = columns.map(row =>
      row.column_name + " | " + row.data_type +
      " | nullable: " + row.is_nullable +
      (row.column_default !== null ? " | default: " + row.column_default : "")
    );
    const constraintLines = constraints.map(row =>
      row.constraint_name + " | " + row.constraint_type + " | " + row.definition
    );

    return [
      "TABLE: " + tableName,
      "COLUMNS",
      columnLines.length ? columnLines.join("\\n") : "No columns returned",
      "CONSTRAINTS",
      constraintLines.length ? constraintLines.join("\\n") : "No constraints found"
    ].join("\\n");
  });
}
