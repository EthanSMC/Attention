#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

curl_bin=${ATTENTION_CURL_BIN:-curl}
if [[ ! -x "$curl_bin" ]] && ! command -v "$curl_bin" >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

check_health() {
  local url=$1 response
  response=$("$curl_bin" --fail --silent --show-error --max-time 10 "$url")
  if [[ "$response" != *'"status":"ok"'* && "$response" != *'"status": "ok"'* ]]; then
    echo "unexpected health response from $url" >&2
    return 1
  fi
  echo "ok: $url"
}

check_health "http://127.0.0.1:9199/api/health"
"$curl_bin" --fail --silent --show-error --max-time 20 \
  --output /dev/null \
  "http://127.0.0.1:9199/ai?view=cards"
echo "ok: database-backed discovery page"

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
fi
