#!/usr/bin/env bash
set -euo pipefail

env_file=${1:-/etc/attention-staging/compose.env}

fail() {
  echo "staging environment invalid: $1" >&2
  exit 1
}

[[ -f "$env_file" ]] || fail "environment file is missing"
[[ ! -L "$env_file" ]] || fail "environment file must not be a symlink"

if mode=$(stat -c '%a' "$env_file" 2>/dev/null); then
  :
elif mode=$(stat -f '%Lp' "$env_file" 2>/dev/null); then
  :
else
  fail "cannot inspect file permissions"
fi
[[ "$mode" == "600" ]] || fail "environment file permissions must be 0600"

if owner=$(stat -c '%u' "$env_file" 2>/dev/null); then
  :
elif owner=$(stat -f '%u' "$env_file" 2>/dev/null); then
  :
else
  fail "cannot inspect file ownership"
fi
[[ "$owner" == "$(id -u)" ]] || fail "environment file must be owned by the validating user"

duplicate_keys=$(awk '
  /^[[:space:]]*($|#)/ { next }
  {
    separator = index($0, "=")
    if (separator < 2) {
      print "<invalid-line>"
      next
    }
    key = substr($0, 1, separator - 1)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
    if (++seen[key] == 2) print key
  }
' "$env_file" | paste -sd, -)
if [[ -n "$duplicate_keys" ]]; then
  fail "duplicate or invalid environment keys: $duplicate_keys"
fi

placeholder_keys=$(awk -F= 'tolower($0) ~ /replace-me/ { print $1 }' "$env_file" | paste -sd, -)
if [[ -n "$placeholder_keys" ]]; then
  fail "replace-me placeholders remain in $placeholder_keys"
fi

value_of() {
  local key=$1
  local value
  value=$(awk -v key="$key" '
    index($0, key "=") == 1 {
      print substr($0, length(key) + 2)
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ' "$env_file") || fail "$key is missing"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value=${value:1:${#value}-2}
  fi
  printf '%s' "$value"
}

require_equal() {
  local key=$1 expected=$2
  local value
  value=$(value_of "$key")
  [[ "$value" == "$expected" ]] || fail "$key has an unsafe staging value"
}

require_min_length() {
  local key=$1 minimum=$2
  local value
  value=$(value_of "$key")
  [[ ${#value} -ge $minimum ]] || fail "$key must contain at least $minimum characters"
}

require_postgres_url() {
  local key=$1 expected_user=$2 password_key=$3
  command -v python3 >/dev/null 2>&1 || fail "python3 is required"
  if ! python3 - "$env_file" "$key" "$expected_user" "$password_key" <<'PY'
import sys
from urllib.parse import unquote, urlsplit

path, key, expected_user, password_key = sys.argv[1:]

values = {}
with open(path, encoding="utf-8") as source:
    for raw_line in source:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if len(value) >= 2 and value[0] == value[-1] == '"':
            value = value[1:-1]
        values[name] = value

try:
    parsed = urlsplit(values[key])
    port = parsed.port
    username = unquote(parsed.username or "")
    password = unquote(parsed.password or "")
except (KeyError, TypeError, ValueError):
    raise SystemExit(1)

valid = (
    parsed.scheme in {"postgres", "postgresql"}
    and username == expected_user
    and password == values.get(password_key)
    and parsed.hostname == "postgres"
    and port == 5432
    and parsed.path == "/attention_staging"
    and not parsed.query
    and not parsed.fragment
)
raise SystemExit(0 if valid else 1)
PY
  then
    fail "$key does not exactly target the isolated Compose database and role"
  fi
}

require_equal COMPOSE_PROJECT_NAME attention-staging
require_equal ATTENTION_POSTGRES_DATA_PATH /data/attention-staging/postgres
require_equal ATTENTION_BACKUP_DIR /data/attention-staging/backups
require_equal ATTENTION_MIGRATION_DATABASE_ROLE attention_migration_owner
require_equal ATTENTION_MIGRATION_DATABASE_HOST postgres
require_equal ATTENTION_MIGRATION_DATABASE_NAME attention_staging
require_equal NEXT_PUBLIC_APP_URL https://attention-staging.noveltystudio.cn
require_equal ATTENTION_MCP_PUBLIC_URL https://attention-staging.noveltystudio.cn/mcp
require_equal ATTENTION_SYNC_PUBLIC_URL https://attention-staging.noveltystudio.cn/api/sync
require_equal ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER x-attention-client-source
require_equal WEB_BIND_ADDRESS 127.0.0.1
require_equal WEB_PUBLISH_PORT 9199
require_equal ATTENTION_EMAIL_PROVIDER resend
require_equal ATTENTION_RESEND_TEMPLATE_ID login-code-attention
require_equal ATTENTION_DIGEST_WORKER_ENABLED false
require_equal WECHAT_ASYNC_REPLY_PROVIDER disabled

for key in \
  POSTGRES_PASSWORD \
  ATTENTION_WEB_DATABASE_PASSWORD \
  ATTENTION_WORKER_DATABASE_PASSWORD \
  ATTENTION_HMAC_SECRET \
  ATTENTION_AUTH_SECRET \
  ATTENTION_CHANNEL_SECRET \
  ATTENTION_CHANNEL_ADAPTER_SECRET \
  FETCHER_SHARED_SECRET; do
  require_min_length "$key" 32
done

require_min_length RESEND_API_KEY 20
resend_key=$(value_of RESEND_API_KEY)
[[ "$resend_key" == re_* ]] || fail "RESEND_API_KEY does not look like a Resend key"
unset resend_key

require_postgres_url MIGRATION_DATABASE_URL attention_migration_owner POSTGRES_PASSWORD
require_postgres_url DATABASE_URL attention_web_runtime ATTENTION_WEB_DATABASE_PASSWORD
require_postgres_url WORKER_DATABASE_URL attention_worker_runtime ATTENTION_WORKER_DATABASE_PASSWORD

if grep -Eq '^ATTENTION_AUTH_EXPOSE_OTP=(1|true|yes)$' "$env_file"; then
  fail "ATTENTION_AUTH_EXPOSE_OTP must not be enabled"
fi

echo "staging environment validation passed"
