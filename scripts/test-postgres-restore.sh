#!/usr/bin/env bash
# Requires the pinned rollback-reference checkout and matching dependency lock from postgres-restore.yml.
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
CREATE TABLE users (id bigint PRIMARY KEY, telegram_id bigint UNIQUE);
CREATE TABLE admin_users (user_id bigint PRIMARY KEY REFERENCES users(id), role text, status text);
CREATE TABLE scheduled_posts (id bigint PRIMARY KEY, title text, status text, content text, scheduled_at timestamptz,
  updated_at timestamptz, preview_message_id bigint, preview_chat_id bigint, approved_by bigint,
  published_message_id bigint, published_at timestamptz);
INSERT INTO users VALUES (1, 8810232463);
INSERT INTO admin_users VALUES (1, 'owner', 'active');
CREATE TABLE admin_audit_logs (
  id bigserial PRIMARY KEY, action varchar(60) NOT NULL, target_user_id bigint,
  admin_user_id bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO admin_audit_logs(action, admin_user_id) VALUES ('legacy_fixture', 1);
INSERT INTO scheduled_posts(id,title,status) VALUES (2,'Legacy post','scheduled');
SQL
initialize_schema() {
DATABASE_URL="postgresql://$PGUSER@$PGHOST:$PGPORT/$1" node --input-type=module <<'JS'
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
}
initialize_schema drill_source
sql drill_source <<'SQL'
INSERT INTO admin_preferences(user_id,language) VALUES (1,'fa');
INSERT INTO admin_audit_logs(admin_user_id,actor_telegram_id,action,target_user_id,currency,metadata,details)
VALUES (1,1001,'restore_drill',1,'USDT','{"source":"fixture"}','{"source":"fixture"}');
INSERT INTO scheduled_posts(id,title,status) VALUES (1,'Restore drill','scheduled');
SQL

pg_dump --format=custom --file="$workdir/synthetic.dump" drill_source
SECONDS=0
pg_restore --exit-on-error --single-transaction --dbname=drill_restored "$workdir/synthetic.dump"
restore_seconds=$SECONDS
initialize_schema drill_restored
initialize_schema drill_restored

# Compare the full seeded rows, including generated IDs, JSON and timestamps.
for table in users admin_users scheduled_posts scheduled_post_history admin_preferences admin_audit_logs; do
  for db in drill_source drill_restored; do
    psql -XAt -v ON_ERROR_STOP=1 -d "$db" -c "SELECT row_to_json(t) FROM $table AS t ORDER BY row_to_json(t)::text" > "$workdir/$db.rows"
  done
  cmp "$workdir/drill_source.rows" "$workdir/drill_restored.rows"
done

sql drill_restored <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_audit_logs WHERE action='legacy_fixture'
                 AND admin_user_id=1 AND actor_telegram_id IS NULL AND currency IS NULL AND metadata IS NULL)
     OR NOT EXISTS (SELECT 1 FROM admin_audit_logs WHERE action='restore_drill' AND currency='USDT'
                    AND metadata=details AND actor_telegram_id=1001) THEN
    RAISE EXCEPTION 'Historical or upgraded audit row changed';
  END IF;
  IF (SELECT count(*) FROM scheduled_post_history WHERE event_type='tracking_started' AND post_id=2) <> 1 THEN
    RAISE EXCEPTION 'Legacy post must have one tracking snapshot across restarts';
  END IF;
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
for revision in rollback-reference candidate; do
  DATABASE_URL="postgresql://$PGUSER@$PGHOST:$PGPORT/drill_restored" node scripts/check-rollback-audit.mjs "$revision"
done
sql drill_restored <<'SQL'
INSERT INTO scheduled_posts(id,title,content,status,preview_chat_id,preview_message_id)
SELECT i,'Fixture post','Offline publication','preview_sent',8810232463,i FROM generate_series(71,73) i;
SQL
for stage in candidate-first rollback-reference candidate-return; do
  DATABASE_URL="postgresql://$PGUSER@$PGHOST:$PGPORT/drill_restored" node scripts/check-rollback-posts.mjs "$stage"
done
for stage in drain restart; do
  DATABASE_URL="postgresql://$PGUSER@$PGHOST:$PGPORT/drill_restored" node scripts/check-preview-shutdown.mjs "$stage"
done
echo "Preview shutdown and restart checks passed."
echo "Scheduled-post rollback and forward checks passed."
echo "Synthetic restore passed (pg_restore: ${restore_seconds}s, six tables). Rollback and forward audit checks passed."
