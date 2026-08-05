#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

dump_path=${1:-}
if [[ -z "$dump_path" || ! -f "$dump_path" || ! -s "$dump_path" ]]; then
  echo "usage: $0 <non-empty custom-format pg_dump file>" >&2
  exit 2
fi

suffix="$(date -u +%Y%m%d%H%M%S)-$$"
container="attention-staging-restore-drill-$suffix"
volume="attention-staging-restore-drill-$suffix"

cleanup() {
  "$ATTENTION_DOCKER_BIN" container rm --force "$container" >/dev/null 2>&1 || true
  "$ATTENTION_DOCKER_BIN" volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"$ATTENTION_DOCKER_BIN" volume create \
  --label com.attention.environment=restore-drill \
  "$volume" >/dev/null
"$ATTENTION_DOCKER_BIN" run --detach \
  --name "$container" \
  --network none \
  --label com.attention.environment=restore-drill \
  --env POSTGRES_DB=attention_restore \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --env POSTGRES_USER=attention_restore_owner \
  --volume "$volume:/var/lib/postgresql/data" \
  postgres:17.6-bookworm >/dev/null

ready=0
for _attempt in $(seq 1 60); do
  if "$ATTENTION_DOCKER_BIN" exec "$container" \
    pg_isready --username=attention_restore_owner --dbname=attention_restore >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" == "1" ]] || {
  echo "restore-drill PostgreSQL did not become ready" >&2
  exit 1
}

"$ATTENTION_DOCKER_BIN" exec --interactive "$container" \
  psql --username=attention_restore_owner --dbname=attention_restore \
  <"$ATTENTION_REPO_ROOT/deploy/postgres/restore-bootstrap-roles.sql" >/dev/null

"$ATTENTION_DOCKER_BIN" exec --interactive "$container" \
  pg_restore \
    --username=attention_restore_owner \
    --dbname=attention_restore \
    --exit-on-error \
    --no-owner \
  <"$dump_path" >/dev/null

restored=$(
  "$ATTENTION_DOCKER_BIN" exec "$container" \
    psql \
      --username=attention_restore_owner \
      --dbname=attention_restore \
      --no-align \
      --tuples-only \
      --set ON_ERROR_STOP=1 \
      --command="
        SELECT
          to_regclass('public.accounts') IS NOT NULL
          AND to_regclass('drizzle.__drizzle_migrations') IS NOT NULL
      "
)
restored=${restored//$'\r'/}
restored=${restored//$'\n'/}
[[ "$restored" == "t" ]] || {
  echo "restore drill completed without required Attention schema" >&2
  exit 1
}

echo "backup restore drill passed in an isolated PostgreSQL 17 container"
