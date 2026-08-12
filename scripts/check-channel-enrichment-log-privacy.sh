#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <macos|linux>" >&2
  exit 64
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_sentinel() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "$name must be set to a non-empty test value"
  fi
}

scan_files() {
  local label="$1"
  shift

  local status
  set +e
  grep -Evq '^[[:space:]]*(-- No entries --)?[[:space:]]*$' -- "$@"
  status=$?
  set -e

  case "$status" in
    0) ;;
    1) fail "$label provided no runtime evidence" ;;
    *) fail "could not read $label" ;;
  esac

  set +e
  grep -Fq \
    -e "$E2E_TEST_URL" \
    -e "$E2E_TITLE_SENTINEL" \
    -e "$E2E_PAGE_SENTINEL" \
    -e "$E2E_SUMMARY_SENTINEL" \
    -e "$E2E_TAG_SENTINEL" \
    -- "$@"
  status=$?
  set -e

  case "$status" in
    0) fail "$label leaked enrichment content" ;;
    1) echo "ok: $label contain no enrichment content" ;;
    *) fail "could not scan $label" ;;
  esac
}

[[ $# -eq 1 ]] || usage
require_sentinel E2E_TEST_URL
require_sentinel E2E_TITLE_SENTINEL
require_sentinel E2E_PAGE_SENTINEL
require_sentinel E2E_SUMMARY_SENTINEL
require_sentinel E2E_TAG_SENTINEL

case "$1" in
  macos)
    logs=(
      "$HOME/.attention/channel/service.log"
      "$HOME/.attention/channel/service-error.log"
    )
    for log in "${logs[@]}"; do
      [[ -f "$log" && -r "$log" ]] || \
        fail "cannot read expected macOS channel log: $log"
    done
    scan_files "macOS channel logs" "${logs[@]}"
    ;;
  linux)
    require_sentinel E2E_LOG_SINCE
    journal_file="$(mktemp "${TMPDIR:-/tmp}/attention-channel-journal.XXXXXX")"
    trap 'rm -f "$journal_file"' EXIT
    if ! journalctl --user --unit=attention-channel.service \
      --since "$E2E_LOG_SINCE" --no-pager --output=cat --quiet \
      >"$journal_file"; then
      fail "could not read Linux channel journal"
    fi
    scan_files "Linux channel journal" "$journal_file"
    ;;
  *) usage ;;
esac
