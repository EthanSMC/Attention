# Attention CLI Self-Update Design

**Date:** 2026-09-03

## Problem

Attention currently updates the background Bridge independently, but the
interactive `attention` command remains at the version installed by the user.
That separation is intentional, yet it means an Agent invoking an older CLI
does not learn that a newer verified CLI is available and cannot perform a
first-party upgrade.

## Goals

- Add an explicit `attention update` command. Running the command is the
  user's authorization to install the newest compatible CLI release; there is
  no additional `--apply` flag.
- Check for a newer CLI release at normal CLI startup no more than once every
  24 hours, with a 1.5 second network timeout.
- When a newer version is known, print a concise reminder on `stderr` on every
  subsequent invocation until the CLI is upgraded.
- Preserve machine-readable `stdout`, especially for `--json` commands.
- Reuse the published Attention CLI manifest and artifact, including exact
  origin, size, Node-version, digest, and candidate-identity validation.
- Upgrade the existing Attention-managed versioned symlink installation
  atomically without changing the independently managed Bridge release.

## Non-goals

- The CLI does not upgrade itself without an explicit `attention update`.
- The CLI does not overwrite npm, Homebrew, or other package-manager-owned
  installations. It reports the appropriate manual upgrade requirement.
- The CLI and Bridge do not have to run the same version.
- Existing CLI releases cannot retroactively gain startup checking. Users need
  one normal/manual CLI update to a release containing this feature.
- This work does not publish or deploy a release.

## User Experience

### Startup reminder

Every ordinary invocation first resolves an update origin and consults a
local cache. A network request is made only when the cache for that origin is
missing or at least 24 hours old. The request has a 1.5 second deadline.
Network, parsing, or cache-write failures are silent and never change the
primary command's exit code.

When the cached, validated manifest contains a newer version, the CLI prints
the following to `stderr` on every invocation:

```text
[update] Attention CLI 0.3.13 is available (current 0.3.12). Run `attention update` to upgrade.
```

The localized CLI may use Chinese copy, but the version pair and exact
`attention update` command are mandatory. `--bridge-update-probe` skips this
logic so its exact machine-readable output remains side-effect free.

### Explicit update

```text
attention update [--origin <https-origin>] [--json]
```

The command always performs a fresh check. If the manifest is current it
reports that no update is needed. If a newer version exists, it downloads and
validates the artifact, probes the candidate, writes a versioned file, and
atomically repoints the Attention-managed global symlink. Plain output names
the old and new versions. JSON output returns stable status, version, and
installation-kind fields without mixing prose into `stdout`.

## Origin Resolution and Cache

Origin precedence is:

1. `--origin` on the current command;
2. `ATTENTION_ORIGIN`;
3. the most recently successful, validated HTTPS origin stored in the CLI
   update cache.

The first startup without an explicit/environment origin and without a saved
origin skips the check. A newly supplied origin is persisted only after its
manifest passes validation. Changing origin invalidates the previous
origin's freshness and triggers an immediate check, so staging and production
results cannot be mixed.

State lives at `~/.attention/cli-update/state.json`, is written atomically
with mode `0600`, and contains no credentials. It records schema version, the
last successfully validated origin, the most recently attempted origin and
time, the latest manifest validated for each recorded origin, and a bounded
stable error code. A failed due check is considered an attempt for that
origin's 24-hour rate limit but does not replace the trusted default origin.
An already validated newer-version reminder for the selected origin remains
available while offline.

## Update Architecture

The release transport is factored into a small shared module used by both the
existing Bridge updater and the new CLI updater. It provides:

- exact-origin, no-redirect manifest fetching;
- JSON content-type and schema validation;
- response-size limits;
- exact artifact URL resolution;
- SHA-256 validation;
- configurable request deadlines.

The CLI updater adds three focused responsibilities:

1. cache and origin resolution;
2. startup-check decision and reminder formatting;
3. managed-install detection and atomic symlink switching.

The command dispatcher invokes the startup check before ordinary command
execution and routes `attention update` to the explicit updater. Dependencies
such as `fetch`, clock, home directory, process entry path, and output streams
remain injectable for deterministic tests.

## Managed Installation Contract

The supported self-update layout is the current Attention standalone layout:

```text
~/.local/bin/attention
  -> ../share/attention/attention-<version>.mjs
```

The updater resolves both paths and verifies that:

- the command path is a symlink named `attention`;
- its current target is a regular file inside
  `~/.local/share/attention`;
- the target basename matches `attention-<semver>.mjs`;
- the observed target still matches immediately before the swap.

The candidate is written atomically with executable permissions to the same
managed directory. A temporary symlink is then renamed over the command
symlink. The previous artifact remains on disk, so an interrupted update or a
failed pre-swap probe leaves the old command usable. Direct `node file.mjs`,
npm, Homebrew, and unrecognized layouts return `unsupported_installation`
without mutation.

## Compatibility and Consent

- The updater never downgrades.
- The manifest's Node requirement must match the running Node version.
- `attention update` is explicit consent for a newer release, including a new
  major version. Automatic startup checks only notify; they never install.
- The existing manifest permission-profile field continues to govern Bridge
  auto-update consent and does not couple the global CLI version to the Bridge.
- Candidate verification executes the downloaded artifact using the existing
  side-effect-free release identity probe and requires the manifest version
  and permission-profile digest to match exactly.

## Error Handling

Startup-check failures are silent. Explicit update failures use stable error
codes and actionable text, leave the command symlink untouched, and return a
non-zero exit code. Expected cases include invalid origin, unavailable or
redirected manifest, unsupported Node, invalid manifest, digest mismatch,
candidate-probe failure, concurrent installation change, and unsupported
installation layout.

## Testing

- Unit-test origin precedence, normalization, first-run behavior, origin
  changes, the 24-hour boundary, the 1.5 second timeout, cached reminders, and
  silent failure behavior.
- Unit-test that reminders go only to `stderr` and never corrupt JSON
  `stdout` or hidden probe output.
- Unit-test explicit current/update/error JSON and human output.
- Use temporary directories to exercise real versioned files and symlinks:
  successful atomic switching, unchanged old link on every failure path,
  candidate collision, concurrent link change, and unsupported layouts.
- Keep the existing Bridge updater suite green after extracting shared release
  transport.
- Run CLI tests, typecheck, artifact generation/check, the full repository
  suite, lint, and production build before completion.

## Release Compatibility

Implementation will bump the CLI package, source constant, public manifest,
and generated single-file artifact together to `0.3.13`. The public manifest
remains schema version 2, so existing Bridge clients continue to understand
it. Deployment and publication are separate decisions and are not part of
this implementation task.
