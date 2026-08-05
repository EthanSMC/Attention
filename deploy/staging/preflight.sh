#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

fail() {
  echo "staging preflight failed: $1" >&2
  exit 1
}

for command in "$ATTENTION_DOCKER_BIN" git python3 ss df awk curl pg_restore find flock stat; do
  if [[ "$command" == */* ]]; then
    [[ -x "$command" ]] || fail "$command is not executable"
  else
    command -v "$command" >/dev/null 2>&1 || fail "$command is required"
  fi
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail "run staging deployment as root"
[[ ! -L "$ATTENTION_REPO_ROOT" ]] || fail "release checkout must not be a symlink"
foreign_owner=$(find "$ATTENTION_REPO_ROOT" -xdev ! -user root -print -quit)
[[ -z "$foreign_owner" ]] || fail "release checkout must be entirely owned by root"
unsafe_mode=$(find "$ATTENTION_REPO_ROOT" -xdev \( -type f -o -type d \) -perm /022 -print -quit)
[[ -z "$unsafe_mode" ]] || fail "release checkout must not be group/world writable"

expected_release_file="$ATTENTION_STATE_DIR/expected-release"
[[ -f "$expected_release_file" && ! -L "$expected_release_file" ]] || \
  fail "root-owned reviewed release record is missing"
expected_release_owner=$(stat -c '%u' "$expected_release_file")
expected_release_mode=$(stat -c '%a' "$expected_release_file")
[[ "$expected_release_owner" == "0" && "$expected_release_mode" == "600" ]] || \
  fail "reviewed release record must be root-owned mode 0600"
ATTENTION_EXPECTED_RELEASE_SHA=$(<"$expected_release_file")
ATTENTION_EXPECTED_RELEASE_SHA=${ATTENTION_EXPECTED_RELEASE_SHA//$'\n'/}
export ATTENTION_EXPECTED_RELEASE_SHA

[[ -f "$ATTENTION_ENV_FILE" ]] || fail "environment file is missing"
"$ATTENTION_STAGING_DIR/validate-env.sh" "$ATTENTION_ENV_FILE" >/dev/null
"$ATTENTION_STAGING_DIR/validate-release-source.sh" "$ATTENTION_REPO_ROOT" >/dev/null

ATTENTION_RELEASE_ID=$(git -C "$ATTENTION_REPO_ROOT" rev-parse --short=12 HEAD)
export ATTENTION_RELEASE_ID
[[ "$ATTENTION_RELEASE_ID" =~ ^[a-f0-9]{12}$ ]] || fail "release ID is invalid"

"$ATTENTION_DOCKER_BIN" version >/dev/null
"$ATTENTION_DOCKER_BIN" compose version >/dev/null

postgres_data_path=$(attention_env_value ATTENTION_POSTGRES_DATA_PATH)
backup_dir=$(attention_env_value ATTENTION_BACKUP_DIR)
for directory in "$postgres_data_path" "$backup_dir" "$ATTENTION_STATE_DIR"; do
  [[ -d "$directory" ]] || fail "required directory is missing: $directory"
  [[ ! -L "$directory" ]] || fail "required directory must not be a symlink: $directory"
  [[ -w "$directory" ]] || fail "required directory is not writable: $directory"
done

available_data_kb=$(df -Pk "$postgres_data_path" | awk 'NR == 2 { print $4 }')
available_docker_kb=$(df -Pk /var/lib/docker | awk 'NR == 2 { print $4 }')
[[ "$available_data_kb" =~ ^[0-9]+$ && "$available_data_kb" -ge 5242880 ]] || \
  fail "less than 5 GiB is available on the Attention data filesystem"
[[ "$available_docker_kb" =~ ^[0-9]+$ && "$available_docker_kb" -ge 8388608 ]] || \
  fail "less than 8 GiB is available for Docker images and build cache"

if [[ -r /proc/meminfo ]]; then
  available_memory_kb=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
  [[ "$available_memory_kb" =~ ^[0-9]+$ && "$available_memory_kb" -ge 3145728 ]] || \
    fail "less than 3 GiB of memory is currently available for a serial on-host build"
fi

if ss -H -ltn 'sport = :9199' | grep -q .; then
  existing_web=$(
    "$ATTENTION_DOCKER_BIN" ps \
      --filter label=com.docker.compose.project=attention-staging \
      --filter label=com.docker.compose.service=web \
      --format '{{.ID}}'
  )
  [[ -n "$existing_web" ]] || fail "host port 9199 is already used outside Attention staging"
fi

attention_compose config --quiet
attention_compose config --format json | \
  python3 "$ATTENTION_STAGING_DIR/validate-compose-config.py" "$postgres_data_path"

echo "staging server preflight passed for release $ATTENTION_RELEASE_ID"
