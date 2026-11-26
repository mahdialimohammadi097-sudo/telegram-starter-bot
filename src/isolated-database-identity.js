// A custom PostgreSQL GUC is user-settable per session. It is not sufficient
// to identify an isolated database. Require the database-wide catalog entry
// (not a role override), in addition to the current effective value and name.
export const isolatedDatabaseIdentitySql = `SELECT
  pg_catalog.current_database() AS database_name,
  pg_catalog.current_setting('profino.environment', true) AS environment,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting s
    JOIN pg_catalog.pg_database d ON d.oid OPERATOR(pg_catalog.=) s.setdatabase
    WHERE d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database() AND s.setrole OPERATOR(pg_catalog.=) 0::pg_catalog.oid
      AND 'profino.environment=isolated-staging'::pg_catalog.text OPERATOR(pg_catalog.=) ANY(s.setconfig)
  ) AS database_marker`;

export function isIsolatedDatabaseIdentity(row, expectedName) {
  return typeof expectedName === "string" && /^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(expectedName)
    && /(?:^|_)(?:staging|test|sandbox)(?:_|$)/i.test(expectedName)
    && row?.database_name === expectedName
    && row.environment === "isolated-staging"
    && row.database_marker === true;
}
