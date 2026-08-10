#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

[[ -f "$ATTENTION_ENV_FILE" ]] || {
  echo "environment file is missing: $ATTENTION_ENV_FILE" >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  echo "python3 is required" >&2
  exit 1
}

read -r expected_count expected_head < <(
  python3 - "$ATTENTION_REPO_ROOT/packages/db/drizzle/meta/_journal.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    entries = json.load(source)["entries"]
print(len(entries), max(entry["when"] for entry in entries))
PY
)

actual=$(
  attention_compose exec -T postgres sh -ceu '
    exec psql \
      --username="$POSTGRES_USER" \
      --dbname="$POSTGRES_DB" \
      --no-align \
      --tuples-only \
      --set ON_ERROR_STOP=1 \
      --command="SELECT count(*), max(created_at) FROM drizzle.__drizzle_migrations"
  '
)
actual=${actual//$'\r'/}
actual=${actual//$'\n'/}
IFS='|' read -r actual_count actual_head <<<"$actual"
[[ "$actual_count" == "$expected_count" && "$actual_head" == "$expected_head" ]] || {
  echo "database migration head does not match the release" >&2
  exit 1
}

role_guard=$(
  attention_compose exec -T postgres sh -ceu '
    exec psql \
      --username="$POSTGRES_USER" \
      --dbname="$POSTGRES_DB" \
      --no-align \
      --tuples-only \
      --set ON_ERROR_STOP=1 \
      --command="
        SELECT count(*) = 2
          AND bool_and(
            rolcanlogin
            AND NOT rolsuper
            AND NOT rolcreatedb
            AND NOT rolcreaterole
            AND NOT rolreplication
            AND NOT rolbypassrls
          )
        FROM pg_roles
        WHERE rolname IN ('"'"'attention_web_runtime'"'"', '"'"'attention_worker_runtime'"'"')
      "
  '
)
role_guard=${role_guard//$'\r'/}
role_guard=${role_guard//$'\n'/}
[[ "$role_guard" == "t" ]] || {
  echo "runtime database roles are missing or over-privileged" >&2
  exit 1
}

password_login_privilege_guard=$(
  attention_compose exec -T postgres sh -ceu '
    exec psql \
      --username="$POSTGRES_USER" \
      --dbname="$POSTGRES_DB" \
      --no-align \
      --tuples-only \
      --set ON_ERROR_STOP=1 \
      --command="SELECT has_column_privilege('\''attention_web_runtime'\'', '\''password_login_attempts'\'', '\''success'\'', '\''UPDATE'\'')"
  '
)
password_login_privilege_guard=${password_login_privilege_guard//$'\r'/}
password_login_privilege_guard=${password_login_privilege_guard//$'\n'/}
[[ "$password_login_privilege_guard" == "t" ]] || {
  echo "web runtime cannot complete a successful password login" >&2
  exit 1
}

verify_runtime_login() {
  local role=$1 password_key=$2 password
  password=$(attention_env_value "$password_key")
  printf '%s\n' "$password" | attention_compose exec -T postgres sh -ceu "
    IFS= read -r PGPASSWORD
    export PGPASSWORD
    exec psql \
      --host=127.0.0.1 \
      --username='$role' \
      --dbname=\"\$POSTGRES_DB\" \
      --no-align \
      --tuples-only \
      --set ON_ERROR_STOP=1 \
      --command='SELECT 1'
  " >/dev/null
  unset password
}

verify_runtime_login attention_web_runtime ATTENTION_WEB_DATABASE_PASSWORD
verify_runtime_login attention_worker_runtime ATTENTION_WORKER_DATABASE_PASSWORD

echo "database migration and runtime-role verification passed"
