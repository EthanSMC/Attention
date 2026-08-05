#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

if [[ "${1:-}" == "--help" ]]; then
  echo "usage: $0"
  echo "deploy the clean current Git commit to Attention staging"
  exit 0
fi
if (($# > 0)); then
  echo "usage: $0" >&2
  exit 2
fi

attention_acquire_operation_lock
"$ATTENTION_STAGING_DIR/preflight.sh"
ATTENTION_RELEASE_ID=$(git -C "$ATTENTION_REPO_ROOT" rev-parse --short=12 HEAD)
export ATTENTION_RELEASE_ID

deployment_failed() {
  echo "deployment failed; database changes are not automatically rolled back" >&2
  echo "inspect service logs and the pre-migration backup before choosing a recovery path" >&2
}
trap deployment_failed ERR

qa_container_before=$(attention_novelty_qa_container)
attention_verify_novelty_qa "$qa_container_before"

existing_postgres=$(attention_compose ps --all --quiet postgres)
existing_postgres=${existing_postgres//$'\r'/}
[[ "$existing_postgres" != *$'\n'* ]] || {
  echo "multiple Attention staging PostgreSQL containers were found" >&2
  exit 1
}

database_initialized=f
pre_migration_schema_head=
if [[ -n "$existing_postgres" ]]; then
  if [[ "$("$ATTENTION_DOCKER_BIN" inspect --format '{{.State.Running}}' "$existing_postgres")" != "true" ]]; then
    "$ATTENTION_DOCKER_BIN" start "$existing_postgres" >/dev/null
  fi
  attention_wait_container_healthy "$existing_postgres" 120

  database_initialized=$(
    attention_compose exec -T postgres sh -ceu '
      exec psql \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --no-align \
        --tuples-only \
        --set ON_ERROR_STOP=1 \
        --command="SELECT to_regclass('"'"'drizzle.__drizzle_migrations'"'"') IS NOT NULL"
    '
  )
  database_initialized=${database_initialized//$'\r'/}
  database_initialized=${database_initialized//$'\n'/}
  [[ "$database_initialized" == "t" || "$database_initialized" == "f" ]] || {
    echo "could not determine whether the staging database is initialized" >&2
    exit 1
  }
fi

if [[ -r "$ATTENTION_STATE_DIR/current-release" && "$database_initialized" != "t" ]]; then
  echo "deployment state exists but the live staging database is not initialized" >&2
  exit 1
fi

if [[ "$database_initialized" == "t" ]]; then
  pre_migration_schema_head=$(attention_database_schema_head)
  if [[ -r "$ATTENTION_STATE_DIR/current-release" ]]; then
    [[ -r "$ATTENTION_STATE_DIR/current-schema-head" ]] || {
      echo "current schema compatibility record is missing" >&2
      exit 1
    }
    recorded_schema_head=$(<"$ATTENTION_STATE_DIR/current-schema-head")
    recorded_schema_head=${recorded_schema_head//$'\n'/}
    [[ "$pre_migration_schema_head" == "$recorded_schema_head" ]] || {
      echo "live database schema differs from the last successful deployment" >&2
      exit 1
    }
  fi
  attention_compose stop web worker >/dev/null 2>&1 || true
  attention_compose stop fetcher >/dev/null 2>&1 || true
  backup_path=$("$ATTENTION_STAGING_DIR/backup.sh" --operation-lock-held)
  "$ATTENTION_STAGING_DIR/restore-drill.sh" "$backup_path"
elif [[ -z "$existing_postgres" ]]; then
  attention_compose pull --policy always postgres
  attention_compose up --detach --wait --wait-timeout 120 postgres
fi

attention_compose pull --policy always runtime-role-passwords
for service in fetcher worker web migrate; do
  COMPOSE_PARALLEL_LIMIT=1 attention_compose build --pull "$service"
done

attention_compose --profile tools run --no-deps --rm migrate
attention_compose --profile tools run --no-deps --rm runtime-role-passwords
"$ATTENTION_STAGING_DIR/verify-database.sh"
attention_compose up --detach --no-deps --wait --wait-timeout 180 fetcher web worker
"$ATTENTION_STAGING_DIR/smoke-test.sh"
attention_verify_novelty_qa "$qa_container_before"

post_migration_schema_head=$(attention_database_schema_head)

umask 077
mkdir -p "$ATTENTION_STATE_DIR"
write_state() {
  local name=$1 value=$2 state_tmp
  state_tmp=$(mktemp "$ATTENTION_STATE_DIR/.$name.XXXXXX")
  printf '%s\n' "$value" >"$state_tmp"
  chmod 0600 "$state_tmp"
  mv "$state_tmp" "$ATTENTION_STATE_DIR/$name"
}
if [[ -r "$ATTENTION_STATE_DIR/current-release" ]]; then
  [[ -n "$pre_migration_schema_head" ]] || {
    echo "cannot record rollback compatibility without the pre-migration schema head" >&2
    exit 1
  }
  current_release=$(<"$ATTENTION_STATE_DIR/current-release")
  current_release=${current_release//$'\n'/}
  write_state previous-release "$current_release"
  write_state previous-schema-head "$pre_migration_schema_head"
fi
write_state current-release "$ATTENTION_RELEASE_ID"
write_state current-schema-head "$post_migration_schema_head"

trap - ERR
echo "Attention staging deployed: $ATTENTION_RELEASE_ID"
echo "next: run smoke-test.sh --public after Nginx/TLS is active"
