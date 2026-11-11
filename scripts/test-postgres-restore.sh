#!/usr/bin/env bash
# Run from a checkout with npm ci and PostgreSQL 17 server/client tools on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

# Ignore inherited libpq destinations, service definitions and credentials.
for name in ${!PG@}; do unset "$name"; done
unset DATABASE_URL
export LC_ALL=C
if [[ "$(postgres -V)" != *" 17."* || "$(pg_dump -V)" != *" 17."* || "$(pg_restore -V)" != *" 17."* ]]; then
  echo "PostgreSQL 17 server and clients required" >&2
  exit 1
fi

workdir=$(mktemp -d /tmp/profino-restore.XXXXXXXX)
cleanup() {
  if [[ -f "$workdir/data/postmaster.pid" ]]; then
    pg_ctl -D "$workdir/data" -m immediate -w stop >/dev/null || return
  fi
  rm -rf -- "$workdir"
}
trap cleanup EXIT
export PGHOST=127.0.0.1 PGUSER=restore_drill
PGPORT=$(node --input-type=module -e "import net from 'node:net'; const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{console.log(s.address().port); s.close()});")
export PGPORT
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "$workdir/password"
PGPASSWORD=$(cat "$workdir/password")
export PGPASSWORD
initdb -D "$workdir/data" --no-locale --encoding=UTF8 --username="$PGUSER" --pwfile="$workdir/password" --auth=scram-sha-256 >/dev/null
pg_ctl -D "$workdir/data" -l "$workdir/server.log" -w start \
  -o "-c listen_addresses=127.0.0.1 -p $PGPORT -c unix_socket_directories=''" >/dev/null
createdb drill_source
createdb drill_restored
sql() { psql -X -v ON_ERROR_STOP=1 -d "$1"; }

# Minimal parent tables for the two production schema initializers.
sql drill_source <<'SQL'
CREATE TABLE users (id bigint PRIMARY KEY);
CREATE TABLE scheduled_posts (id bigint PRIMARY KEY, title text, status text, content text, scheduled_at timestamptz);
INSERT INTO users VALUES (1);
SQL
DATABASE_URL="postgresql://$PGUSER@$PGHOST:$PGPORT/drill_source" node --input-type=module <<'JS'
import { ensureAdminOpsSchema } from './src/admin-ops.js';
import { ensurePostHistorySchema } from './src/post-history.js';
import { closeDatabase } from './src/database.js';
try {
  await ensureAdminOpsSchema();
  await ensurePostHistorySchema();
} finally {
  await closeDatabase();
}
JS
sql drill_source <<'SQL'
INSERT INTO admin_preferences(user_id,language) VALUES (1,'fa');
INSERT INTO admin_audit_logs(actor_telegram_id,action) VALUES (1,'restore_drill');
INSERT INTO scheduled_posts(id,title,status) VALUES (1,'Restore drill','scheduled');
SQL

pg_dump --format=custom --file="$workdir/synthetic.dump" drill_source
SECONDS=0
pg_restore --exit-on-error --single-transaction --dbname=drill_restored "$workdir/synthetic.dump"
restore_seconds=$SECONDS

# Compare the full seeded rows, including generated IDs, JSON and timestamps.
for table in users scheduled_posts scheduled_post_history admin_preferences admin_audit_logs; do
  for db in drill_source drill_restored; do
    psql -XAt -v ON_ERROR_STOP=1 -d "$db" -c "SELECT row_to_json(t) FROM $table AS t ORDER BY row_to_json(t)::text" > "$workdir/$db.rows"
  done
  cmp "$workdir/drill_source.rows" "$workdir/drill_restored.rows"
done

sql drill_restored <<'SQL'
DO $$
BEGIN
  IF (SELECT count(*) FROM scheduled_post_history WHERE event_type='created' AND post_id=1) <> 1 THEN
    RAISE EXCEPTION 'Missing restored creation event';
  END IF;
  UPDATE scheduled_posts SET status='published' WHERE id=1;
  IF (SELECT count(*) FROM scheduled_post_history WHERE post_id=1 AND event_type='status_changed'
      AND old_status='scheduled' AND new_status='published') <> 1 THEN
    RAISE EXCEPTION 'Restored history trigger failed';
  END IF;
  IF to_regclass('public.idx_scheduled_post_history_post') IS NULL OR
     to_regclass('public.idx_admin_audit_logs_created') IS NULL THEN
    RAISE EXCEPTION 'Missing restored index';
  END IF;
  BEGIN
    UPDATE admin_preferences SET language='xx' WHERE user_id=1;
    RAISE EXCEPTION 'Missing language constraint';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO admin_preferences(user_id) VALUES (2);
    RAISE EXCEPTION 'Missing user foreign key';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
SQL
echo "Synthetic restore passed (pg_restore: ${restore_seconds}s, five tables)."
