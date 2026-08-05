#!/usr/bin/env bash
set -euo pipefail

host=${1:-}
nc_bin=${ATTENTION_NC_BIN:-nc}

if [[ -z "$host" ]]; then
  echo "usage: $0 <public-ip-or-hostname>" >&2
  exit 2
fi
if [[ ! -x "$nc_bin" ]] && ! command -v "$nc_bin" >/dev/null 2>&1; then
  echo "nc is required" >&2
  exit 2
fi

reachable() {
  "$nc_bin" -z -w 3 "$host" "$1" >/dev/null 2>&1
}

failed=0
for port in 80 443; do
  if reachable "$port"; then
    echo "ok: public edge port $port is reachable"
  else
    echo "error: required public edge port $port is not reachable" >&2
    failed=1
  fi
done

for port in 5432 9199 4100 9299; do
  if reachable "$port"; then
    echo "error: internal port $port is publicly reachable" >&2
    failed=1
  else
    echo "ok: internal port $port is not publicly reachable"
  fi
done

if reachable 9099; then
  echo "warning: pre-existing Novelty QA port 9099 is publicly reachable" >&2
else
  echo "ok: pre-existing Novelty QA port 9099 is not publicly reachable"
fi

exit "$failed"
