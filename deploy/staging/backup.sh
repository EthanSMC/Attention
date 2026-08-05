#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

operation_lock_held=false
if [[ "${1:-}" == "--operation-lock-held" ]]; then
  operation_lock_held=true
  shift
fi
if (($# > 0)); then
  echo "usage: $0 [--operation-lock-held]" >&2
  exit 2
fi
if [[ "$operation_lock_held" != "true" ]]; then
  attention_acquire_operation_lock
fi

[[ -f "$ATTENTION_ENV_FILE" ]] || {
  echo "environment file is missing: $ATTENTION_ENV_FILE" >&2
  exit 1
}

backup_dir=${ATTENTION_BACKUP_DIR:-$(attention_env_value ATTENTION_BACKUP_DIR)}
case "$backup_dir" in
  ""|/|/data|/var|/var/backups)
    echo "refusing unsafe backup directory: $backup_dir" >&2
    exit 1
    ;;
esac

pg_restore_bin=${ATTENTION_PG_RESTORE_BIN:-pg_restore}
if [[ ! -x "$pg_restore_bin" ]] && ! command -v "$pg_restore_bin" >/dev/null 2>&1; then
  echo "pg_restore is required to verify backups" >&2
  exit 1
fi

umask 077
mkdir -p "$backup_dir"
chmod 0700 "$backup_dir"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
final_path="$backup_dir/attention-staging-$stamp-$$.dump"
partial_path="$final_path.partial"

[[ ! -e "$final_path" && ! -e "$partial_path" ]] || {
  echo "refusing to overwrite an existing staging backup" >&2
  exit 1
}

cleanup() {
  if [[ -f "$partial_path" ]]; then
    rm -f -- "$partial_path"
  fi
}
trap cleanup EXIT

set -o noclobber
attention_compose exec -T postgres sh -ceu '
  exec pg_dump \
    --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB" \
    --format=custom \
    --compress=9 \
    --no-password
' >"$partial_path"
set +o noclobber

chmod 0600 "$partial_path"
[[ -s "$partial_path" ]] || {
  echo "database backup is empty" >&2
  exit 1
}
"$pg_restore_bin" --list "$partial_path" >/dev/null
mv "$partial_path" "$final_path"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$final_path" >"$final_path.sha256"
else
  shasum -a 256 "$final_path" >"$final_path.sha256"
fi
chmod 0600 "$final_path.sha256"

shopt -s nullglob
dumps=("$backup_dir"/attention-staging-*.dump)
while ((${#dumps[@]} > 14)); do
  oldest=${dumps[0]}
  rm -f -- "$oldest" "$oldest.sha256"
  dumps=("${dumps[@]:1}")
done

trap - EXIT
echo "$final_path"
