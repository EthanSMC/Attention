#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

curl_bin=${ATTENTION_CURL_BIN:-curl}
if [[ ! -x "$curl_bin" ]] && ! command -v "$curl_bin" >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

smoke_temp_directory=$(mktemp -d "${TMPDIR:-/tmp}/attention-staging-smoke.XXXXXX")
trap 'rm -rf -- "$smoke_temp_directory"' EXIT

check_health() {
  local url=$1 response
  response=$("$curl_bin" --fail --silent --show-error --max-time 10 "$url")
  if [[ "$response" != *'"status":"ok"'* && "$response" != *'"status": "ok"'* ]]; then
    echo "unexpected health response from $url" >&2
    return 1
  fi
  echo "ok: $url"
}

check_installation_assets() {
  local origin=$1 label=$2 bundle_path relative expected actual
  bundle_path=$(python3 - "$ATTENTION_REPO_ROOT/apps/web/public/skills/attention/installations/v1/agents/workbuddy.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    manifest = json.load(source)
path = manifest["skill"]["bundle_path"]
if not isinstance(path, str) or not path.startswith("/skills/attention/bundles/"):
    raise SystemExit("invalid WorkBuddy bundle path")
print(path)
PY
  )

  for relative in \
    "/skills/attention/SKILL.md" \
    "/skills/attention/INSTALL.md" \
    "/skills/attention/capabilities/v1/index.json" \
    "/skills/attention/capabilities/v1/schema.json" \
    "/skills/attention/installations/v1/index.json" \
    "$bundle_path"; do
    expected="$ATTENTION_REPO_ROOT/apps/web/public$relative"
    [[ -f "$expected" ]] || {
      echo "release installation asset is missing: $expected" >&2
      return 1
    }
    actual="$smoke_temp_directory/${label}-${relative//\//_}"
    "$curl_bin" --fail --silent --show-error --max-time 20 \
      --output "$actual" \
      "${origin%/}$relative"
    cmp --silent "$expected" "$actual" || {
      echo "served installation asset differs from release: $relative" >&2
      return 1
    }
  done
  echo "ok: $label Agent installation assets"
}

check_health "http://127.0.0.1:9199/api/health"
"$curl_bin" --fail --silent --show-error --max-time 20 \
  --output /dev/null \
  "http://127.0.0.1:9199/ai?view=cards"
echo "ok: database-backed discovery page"
check_installation_assets "http://127.0.0.1:9199" "internal"

if [[ "${1:-}" == "--public" ]]; then
  [[ -f "$ATTENTION_ENV_FILE" ]] || {
    echo "environment file is missing: $ATTENTION_ENV_FILE" >&2
    exit 1
  }
  public_origin=$(attention_env_value NEXT_PUBLIC_APP_URL)
  [[ "$public_origin" == "https://attention-staging.noveltystudio.cn" ]] || {
    echo "unexpected staging public origin" >&2
    exit 1
  }
  check_health "$public_origin/api/health"
  "$curl_bin" --fail --silent --show-error --max-time 20 \
    --output /dev/null \
    "$public_origin/ai?view=cards"
  echo "ok: public database-backed discovery page"
  check_installation_assets "$public_origin" "public"
fi
