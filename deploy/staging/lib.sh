#!/usr/bin/env bash

ATTENTION_STAGING_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ATTENTION_REPO_ROOT=$(cd "$ATTENTION_STAGING_DIR/../.." && pwd)
ATTENTION_ENV_FILE=${ATTENTION_ENV_FILE:-/etc/attention-staging/compose.env}
ATTENTION_STATE_DIR=${ATTENTION_STATE_DIR:-/var/lib/attention-staging}
ATTENTION_DOCKER_BIN=${ATTENTION_DOCKER_BIN:-docker}
ATTENTION_PROJECT_NAME=attention-staging

attention_acquire_operation_lock() {
  local flock_bin=${ATTENTION_FLOCK_BIN:-flock}
  if [[ "$flock_bin" == */* ]]; then
    [[ -x "$flock_bin" ]] || {
      echo "flock is required" >&2
      return 1
    }
  elif ! command -v "$flock_bin" >/dev/null 2>&1; then
    echo "flock is required" >&2
    return 1
  fi
  [[ -d "$ATTENTION_STATE_DIR" && ! -L "$ATTENTION_STATE_DIR" ]] || {
    echo "Attention staging state directory is missing or unsafe" >&2
    return 1
  }
  umask 077
  exec 9>"$ATTENTION_STATE_DIR/operation.lock"
  chmod 0600 "$ATTENTION_STATE_DIR/operation.lock"
  if ! "$flock_bin" -n 9; then
    echo "another Attention staging deploy, rollback, or backup is already running" >&2
    return 1
  fi
}

attention_env_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
      if (value ~ /^".*"$/) value = substr(value, 2, length(value) - 2)
      print value
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ' "$ATTENTION_ENV_FILE"
}

attention_load_release_id() {
  if [[ -n "${ATTENTION_RELEASE_ID:-}" ]]; then
    export ATTENTION_RELEASE_ID
    return
  fi
  if [[ -r "$ATTENTION_STATE_DIR/current-release" ]]; then
    ATTENTION_RELEASE_ID=$(<"$ATTENTION_STATE_DIR/current-release")
    export ATTENTION_RELEASE_ID
    return
  fi
  echo "ATTENTION_RELEASE_ID is required (or deploy once to create current-release)" >&2
  return 1
}

attention_compose() {
  attention_load_release_id
  "$ATTENTION_DOCKER_BIN" compose \
    --project-name "$ATTENTION_PROJECT_NAME" \
    --file "$ATTENTION_REPO_ROOT/compose.yaml" \
    --file "$ATTENTION_STAGING_DIR/compose.staging.yaml" \
    --env-file "$ATTENTION_ENV_FILE" \
    "$@"
}

attention_wait_container_healthy() {
  local container=$1 timeout_seconds=${2:-120} status
  for _attempt in $(seq 1 "$timeout_seconds"); do
    status=$("$ATTENTION_DOCKER_BIN" inspect \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "$container")
    case "$status" in
      healthy) return 0 ;;
      unhealthy|dead|exited)
        echo "container did not become healthy: $container ($status)" >&2
        return 1
        ;;
    esac
    sleep 1
  done
  echo "container health timed out: $container" >&2
  return 1
}

attention_database_schema_head() {
  local head
  head=$(attention_compose exec -T postgres sh -ceu '
    exec psql \
      --username="$POSTGRES_USER" \
      --dbname="$POSTGRES_DB" \
      --no-align \
      --tuples-only \
      --set ON_ERROR_STOP=1 \
      --command="SELECT max(created_at) FROM drizzle.__drizzle_migrations"
  ')
  head=${head//$'\r'/}
  head=${head//$'\n'/}
  [[ "$head" =~ ^[0-9]+$ ]] || {
    echo "cannot determine the live database schema head" >&2
    return 1
  }
  printf '%s\n' "$head"
}

attention_novelty_qa_container() {
  local containers
  containers=$("$ATTENTION_DOCKER_BIN" ps \
    --filter publish=9099 \
    --format '{{.ID}}')
  containers=${containers//$'\r'/}
  [[ -n "$containers" && "$containers" != *$'\n'* ]] || {
    echo "expected exactly one running Novelty QA container publishing 9099" >&2
    return 1
  }
  printf '%s\n' "$containers"
}

attention_verify_novelty_qa() {
  local expected_container=$1 actual_container curl_bin=${ATTENTION_CURL_BIN:-curl}
  actual_container=$(attention_novelty_qa_container)
  [[ "$actual_container" == "$expected_container" ]] || {
    echo "Novelty QA container changed during the Attention operation" >&2
    return 1
  }
  "$curl_bin" --fail --silent --show-error --max-time 10 \
    http://127.0.0.1:9099/api/about/ai-disclosure >/dev/null
}
