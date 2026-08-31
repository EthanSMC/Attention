#!/usr/bin/env bash
set -euo pipefail

target=${1:-/etc/attention-staging/compose.env}

if [[ -e "$target" ]]; then
  echo "refusing to overwrite existing environment file: $target" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required" >&2
  exit 1
fi

parent=$(dirname "$target")
if [[ ! -d "$parent" ]]; then
  echo "target directory does not exist: $parent" >&2
  exit 1
fi

random_secret() {
  openssl rand -hex 32
}

owner_password=$(random_secret)
web_password=$(random_secret)
worker_password=$(random_secret)
hmac_secret=$(random_secret)
auth_secret=$(random_secret)
channel_secret=$(random_secret)
channel_pairing_secret=$(random_secret)
adapter_secret=$(random_secret)
fetcher_secret=$(random_secret)
wechat_app_secret=$(random_secret)
wechat_callback_token=$(random_secret)

umask 077
{
  printf '%s\n' '# Generated once by deploy/staging/generate-env.sh.'
  printf '%s\n' '# Keep this file outside the repository and readable only by root.'
  printf 'COMPOSE_PROJECT_NAME=attention-staging\n'
  printf 'ATTENTION_POSTGRES_DATA_PATH=/data/attention-staging/postgres\n'
  printf 'ATTENTION_BACKUP_DIR=/data/attention-staging/backups\n'
  printf '\n'
  printf 'POSTGRES_DB=attention_staging\n'
  printf 'POSTGRES_USER=attention_migration_owner\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$owner_password"
  printf 'MIGRATION_DATABASE_URL=postgresql://attention_migration_owner:%s@postgres:5432/attention_staging\n' "$owner_password"
  printf 'ATTENTION_MIGRATION_DATABASE_ROLE=attention_migration_owner\n'
  printf 'ATTENTION_MIGRATION_DATABASE_HOST=postgres\n'
  printf 'ATTENTION_MIGRATION_DATABASE_NAME=attention_staging\n'
  printf 'ATTENTION_WEB_DATABASE_PASSWORD=%s\n' "$web_password"
  printf 'ATTENTION_WORKER_DATABASE_PASSWORD=%s\n' "$worker_password"
  printf 'DATABASE_URL=postgresql://attention_web_runtime:%s@postgres:5432/attention_staging\n' "$web_password"
  printf 'WORKER_DATABASE_URL=postgresql://attention_worker_runtime:%s@postgres:5432/attention_staging\n' "$worker_password"
  printf '\n'
  printf 'ATTENTION_HMAC_SECRET=%s\n' "$hmac_secret"
  printf 'ATTENTION_AUTH_SECRET=%s\n' "$auth_secret"
  printf 'ATTENTION_CHANNEL_SECRET=%s\n' "$channel_secret"
  printf 'ATTENTION_CHANNEL_PAIRING_SECRET=%s\n' "$channel_pairing_secret"
  printf 'ATTENTION_CHANNEL_ADAPTER_SECRET=%s\n' "$adapter_secret"
  printf 'FETCHER_SHARED_SECRET=%s\n' "$fetcher_secret"
  printf 'FETCHER_MAX_CONCURRENCY=8\n'
  printf 'FETCHER_MAX_QUEUE=16\n'
  printf 'FETCHER_QUEUE_TIMEOUT_MS=1000\n'
  printf '\n'
  printf 'NEXT_PUBLIC_APP_URL=https://attention-staging.noveltystudio.cn\n'
  printf 'ATTENTION_ADMIN_EMAILS=\n'
  printf 'ATTENTION_MCP_PUBLIC_URL=https://attention-staging.noveltystudio.cn/mcp\n'
  printf 'ATTENTION_SYNC_PUBLIC_URL=https://attention-staging.noveltystudio.cn/api/sync\n'
  printf 'ATTENTION_CHANNEL_RUNTIME_PUBLIC_URL=https://attention-staging.noveltystudio.cn/api/runtime\n'
  printf 'PUBLIC_FEED_PREVIEW_LIMIT=20\n'
  printf 'ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER=x-attention-client-source\n'
  printf 'ATTENTION_OAUTH_REGISTRATION_HOURLY_LIMIT=100\n'
  printf 'ATTENTION_OAUTH_REGISTRATION_SOURCE_HOURLY_LIMIT=10\n'
  printf 'ATTENTION_MCP_REQUESTS_PER_MINUTE=120\n'
  printf 'ATTENTION_FILTER_REPORT_CASE_LIMIT_24H=10\n'
  printf 'ATTENTION_CONSUMER_INVITE_QUOTA=1\n'
  printf 'WEB_BIND_ADDRESS=127.0.0.1\n'
  printf 'WEB_PUBLISH_PORT=9199\n'
  printf '\n'
  printf 'ATTENTION_EMAIL_PROVIDER=resend\n'
  printf 'RESEND_API_KEY=replace-me-with-a-new-rotated-resend-key\n'
  printf '%s\n' 'ATTENTION_RESEND_FROM="Attention <no_reply@service.noveltystudio.cn>"'
  printf 'ATTENTION_RESEND_TEMPLATE_ID=attention-login-code\n'
  printf 'ATTENTION_EMAIL_WEBHOOK_URL=\n'
  printf 'ATTENTION_EMAIL_WEBHOOK_TOKEN=\n'
  printf 'ATTENTION_DIGEST_WORKER_ENABLED=false\n'
  printf '\n'
  printf 'ATTENTION_AI_MODEL=\n'
  printf 'ATTENTION_AI_BASE_URL=https://api.openai.com/v1\n'
  printf 'ATTENTION_AI_API_KEY=\n'
  printf 'ATTENTION_BILLING_PROVIDER=\n'
  printf 'ATTENTION_BILLING_CHECKOUT_WEBHOOK=\n'
  printf 'ATTENTION_BILLING_WEBHOOK_SECRET=\n'
  printf '\n'
  printf 'ATTENTION_CHANNEL_API_BASE_URL=https://attention-staging.noveltystudio.cn\n'
  printf 'WECHAT_BIND_ADDRESS=127.0.0.1\n'
  printf 'WECHAT_PUBLISH_PORT=9299\n'
  printf 'WECHAT_APP_ID=wx0000000000000000\n'
  printf 'WECHAT_APP_SECRET=%s\n' "$wechat_app_secret"
  printf 'WECHAT_CALLBACK_TOKEN=%s\n' "$wechat_callback_token"
  printf 'WECHAT_ENCODING_AES_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n'
  printf 'WECHAT_MESSAGE_MODE=safe\n'
  printf 'WECHAT_ASYNC_REPLY_PROVIDER=disabled\n'
} >"$target"
chmod 0600 "$target"

echo "created $target with mode 0600"
echo "replace RESEND_API_KEY with a newly rotated key before validation"
