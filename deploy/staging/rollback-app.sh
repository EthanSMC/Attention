#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

target_release=${1:-}
if [[ ! "$target_release" =~ ^[a-f0-9]{12,64}$ ]]; then
  echo "usage: $0 <existing-release-id (12-64 lowercase hex characters)>" >&2
  exit 2
fi
[[ -f "$ATTENTION_ENV_FILE" ]] || {
  echo "environment file is missing: $ATTENTION_ENV_FILE" >&2
  exit 1
}
[[ -d "$ATTENTION_STATE_DIR" ]] || {
  echo "state directory is missing: $ATTENTION_STATE_DIR" >&2
  exit 1
}
[[ -r "$ATTENTION_STATE_DIR/current-release" ]] || {
  echo "current release record is missing" >&2
  exit 1
}
[[ -r "$ATTENTION_STATE_DIR/current-schema-head" && \
   -r "$ATTENTION_STATE_DIR/previous-release" && \
   -r "$ATTENTION_STATE_DIR/previous-schema-head" ]] || {
  echo "rollback compatibility records are missing" >&2
  exit 1
}

attention_acquire_operation_lock
"$ATTENTION_STAGING_DIR/validate-env.sh" "$ATTENTION_ENV_FILE" >/dev/null

for service in web worker fetcher; do
  image="attention-staging-$service:$target_release"
  if ! "$ATTENTION_DOCKER_BIN" image inspect "$image" >/dev/null 2>&1; then
    echo "rollback image is missing: $image" >&2
    exit 1
  fi
done

current_release=$(<"$ATTENTION_STATE_DIR/current-release")
current_release=${current_release//$'\n'/}
previous_release=$(<"$ATTENTION_STATE_DIR/previous-release")
previous_release=${previous_release//$'\n'/}
[[ "$target_release" == "$previous_release" ]] || {
  echo "rollback target must be the recorded previous release" >&2
  exit 1
}

current_schema_head=$(<"$ATTENTION_STATE_DIR/current-schema-head")
current_schema_head=${current_schema_head//$'\n'/}
previous_schema_head=$(<"$ATTENTION_STATE_DIR/previous-schema-head")
previous_schema_head=${previous_schema_head//$'\n'/}
live_schema_head=$(attention_database_schema_head)
[[ "$live_schema_head" == "$current_schema_head" ]] || {
  echo "live database schema does not match the current deployment record" >&2
  exit 1
}
[[ "$live_schema_head" == "$previous_schema_head" ]] || {
  echo "application rollback blocked because the database schema advanced" >&2
  exit 1
}

qa_container_before=$(attention_novelty_qa_container)
attention_verify_novelty_qa "$qa_container_before"
ATTENTION_RELEASE_ID=$target_release
export ATTENTION_RELEASE_ID

"$ATTENTION_STAGING_DIR/verify-database.sh" >/dev/null
attention_compose up --detach --no-build --no-deps --wait --wait-timeout 180 fetcher web worker
"$ATTENTION_STAGING_DIR/smoke-test.sh" >/dev/null
attention_verify_novelty_qa "$qa_container_before"

umask 077
write_state() {
  local name=$1 value=$2 state_tmp
  state_tmp=$(mktemp "$ATTENTION_STATE_DIR/.$name.XXXXXX")
  printf '%s\n' "$value" >"$state_tmp"
  chmod 0600 "$state_tmp"
  mv "$state_tmp" "$ATTENTION_STATE_DIR/$name"
}
write_state previous-release "$current_release"
write_state previous-schema-head "$current_schema_head"
write_state current-release "$target_release"
write_state current-schema-head "$previous_schema_head"

echo "application rollback completed: $target_release"
echo "database schema was not changed; confirm release/schema compatibility"
