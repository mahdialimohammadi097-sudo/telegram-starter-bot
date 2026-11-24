-- REVIEW ONLY. Do not execute against production without reviewed live schema,
-- trusted function owner, backup/rollback and separate migration authorization.
-- Grant EXECUTE only to the confirmed restricted runtime role after review.
-- No grant to PUBLIC. No money movement, schema auto-install or role creation.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
CREATE FUNCTION public.profino_lock_active_owner()
RETURNS bigint LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $owner_lock$SELECT au.user_id::bigint
FROM "public".admin_users au
JOIN "public".users u ON u.id = au.user_id
WHERE u.telegram_id = 8810232463 AND au.role = 'owner' AND au.status = 'active'
LIMIT 1 FOR SHARE OF au, u$owner_lock$;
REVOKE ALL ON FUNCTION public.profino_lock_active_owner() FROM PUBLIC;
COMMIT;
