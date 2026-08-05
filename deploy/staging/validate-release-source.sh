#!/usr/bin/env bash
set -euo pipefail

repo=${1:-$(cd "$(dirname "$0")/../.." && pwd)}

fail() {
  echo "release source invalid: $1" >&2
  exit 1
}

git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not a Git checkout"

expected_release=${ATTENTION_EXPECTED_RELEASE_SHA:-}
[[ "$expected_release" =~ ^[a-f0-9]{40,64}$ ]] || \
  fail "ATTENTION_EXPECTED_RELEASE_SHA must name the reviewed release commit"
actual_release=$(git -C "$repo" rev-parse --verify 'HEAD^{commit}') || \
  fail "cannot resolve the release commit"
[[ "$actual_release" == "$expected_release" ]] || \
  fail "checkout does not match the reviewed release commit"

if ! git -C "$repo" diff --quiet --ignore-submodules -- || \
  ! git -C "$repo" diff --cached --quiet --ignore-submodules -- || \
  [[ -n "$(git -C "$repo" ls-files --others --exclude-standard)" ]]; then
  fail "deployment requires a clean Git commit"
fi

required_files=(
  Dockerfile
  compose.yaml
  pnpm-lock.yaml
  packages/db/drizzle/0015_account_avatar.sql
  packages/db/drizzle/0016_attention_id.sql
  packages/db/drizzle/0017_consumer_invite_quota.sql
  packages/db/drizzle/0018_schema_checkpoint.sql
  packages/db/drizzle/meta/0018_snapshot.json
  packages/db/drizzle/meta/_journal.json
)

for file in "${required_files[@]}"; do
  git -C "$repo" ls-files --error-unmatch "$file" >/dev/null 2>&1 || \
    fail "$file is not tracked in the release commit"
done

printf '%s\n' "$actual_release"
