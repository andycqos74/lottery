#!/usr/bin/env bash
# Application database: the login role, then the migrations.
#
# The separation matters (db/migrations/0007): migrations run as lottery_owner,
# the application connects as lottery_app, and lottery_app holds no UPDATE or
# DELETE grant on ledger_entry or audit_log. If the application ran migrations,
# it would need the privileges the append-only guarantee exists to deny it.
set -euo pipefail

cd "$(dirname "$0")/../.."

APP_PW="$(cat deploy/secrets/app_role_password)"
OWNER_PW="$(cat deploy/secrets/app_db_password)"
HOST="${APP_DB_HOST:-127.0.0.1}"
PORT="${APP_DB_PORT:-5432}"

echo "── 1. Login role ──────────────────────────────────────────────────────────"
PGPASSWORD="${OWNER_PW}" psql -h "${HOST}" -p "${PORT}" -U lottery_owner -d lottery_app -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lottery_app') THEN
    CREATE ROLE lottery_app NOLOGIN;
  END IF;
END \$\$;
ALTER ROLE lottery_app LOGIN PASSWORD '${APP_PW}';
-- Belt and braces: the application can never create objects it would then own,
-- and therefore never grant itself privileges on them.
REVOKE CREATE ON SCHEMA public FROM lottery_app;
SQL

echo "── 2. Migrations (as owner) ───────────────────────────────────────────────"
APP_DB_MIGRATION_URL="postgres://lottery_owner:${OWNER_PW}@${HOST}:${PORT}/lottery_app" \
  pnpm exec tsx packages/db/src/cli/migrate.ts

echo ""
echo "── 3. Verifying the append-only guarantee actually holds ──────────────────"
PGPASSWORD="${OWNER_PW}" psql -h "${HOST}" -p "${PORT}" -U lottery_owner -d lottery_app -tA <<'SQL'
SELECT CASE WHEN count(*) = 0
  THEN '  ✓ lottery_app holds no UPDATE/DELETE on ledger_entry or audit_log (T-9.4)'
  ELSE '  ✗ FAIL: lottery_app can still rewrite the books — ' || string_agg(table_name||':'||privilege_type, ', ')
END FROM information_schema.role_table_grants
 WHERE grantee='lottery_app' AND table_name IN ('ledger_entry','audit_log')
   AND privilege_type IN ('UPDATE','DELETE','TRUNCATE');
SQL
