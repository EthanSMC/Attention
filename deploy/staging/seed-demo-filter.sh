#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

if [[ "${1:-}" == "--help" ]]; then
  echo "usage: export ATTENTION_DEMO_FILTER_PASSWORD; ATTENTION_SEED_DEMO_FILTER=1 $0"
  echo "seed the staging Filter demo account without storing its password in the repository"
  exit 0
fi
if (($# > 0)); then
  echo "usage: $0" >&2
  exit 2
fi

[[ "${ATTENTION_SEED_DEMO_FILTER:-}" == "1" ]] || {
  echo "refusing to seed without ATTENTION_SEED_DEMO_FILTER=1" >&2
  exit 1
}
[[ -n "${ATTENTION_DEMO_FILTER_PASSWORD:-}" ]] || {
  echo "export ATTENTION_DEMO_FILTER_PASSWORD in the current shell first" >&2
  exit 1
}

attention_acquire_operation_lock
attention_compose --profile tools run --no-deps --rm \
  -e ATTENTION_SEED_DEMO_FILTER \
  -e ATTENTION_DEMO_FILTER_PASSWORD \
  migrate node seed-demo-filter.js
