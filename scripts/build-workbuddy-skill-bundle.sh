#!/usr/bin/env bash

set -euo pipefail

bundle_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle_source="$bundle_repo_root/apps/web/public/skills/attention/SKILL.md"

if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required to build the WorkBuddy Skill bundle." >&2
  exit 1
fi

if [ ! -f "$bundle_source" ]; then
  echo "Attention SKILL.md was not found at $bundle_source." >&2
  exit 1
fi

bundle_skill_version="$(
  sed -n 's/^Skill version: `\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)`$/\1/p' "$bundle_source"
)"
if [ -z "$bundle_skill_version" ]; then
  echo "Could not read a semantic Skill version from $bundle_source." >&2
  exit 1
fi

bundle_default_output="$bundle_repo_root/apps/web/public/skills/attention/bundles/attention-workbuddy-$bundle_skill_version.zip"
bundle_output="${1:-$bundle_default_output}"

mkdir -p "$(dirname "$bundle_output")"
bundle_output_directory="$(cd "$(dirname "$bundle_output")" && pwd)"
bundle_output="$bundle_output_directory/$(basename "$bundle_output")"
bundle_staging_directory="$(mktemp -d "${TMPDIR:-/tmp}/attention-workbuddy-bundle.XXXXXX")"
bundle_publish_directory="$(mktemp -d "$bundle_output_directory/.attention-workbuddy-publish.XXXXXX")"
bundle_temporary_output="$bundle_publish_directory/$(basename "$bundle_output")"

bundle_cleanup() {
  rm -rf "$bundle_staging_directory"
  rm -rf "$bundle_publish_directory"
}
trap bundle_cleanup EXIT

install -m 0644 "$bundle_source" "$bundle_staging_directory/SKILL.md"

# ZIP records file modification times. Normalize the staged copy so the same
# SKILL.md bytes produce the same archive on macOS and Linux. WorkBuddy's
# documented package format requires SKILL.md at the archive root.
touch -t 198001010000 "$bundle_staging_directory/SKILL.md"

(
  cd "$bundle_staging_directory"
  # Store without compression so the archive bytes do not depend on a zlib
  # implementation while remaining far below WorkBuddy's 10 MB limit.
  LC_ALL=C zip -X -0 -q "$bundle_temporary_output" SKILL.md
)

# The temporary archive lives on the destination filesystem, so this rename is
# atomic and an interrupted build cannot remove the last known-good bundle.
mv -f "$bundle_temporary_output" "$bundle_output"

echo "$bundle_output"
